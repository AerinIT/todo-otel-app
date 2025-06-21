import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

// Test configuration
export const options = {
  scenarios: {
    continuous_test: {
      executor: 'constant-vus',
      vus: 1,  // Single virtual user
      duration: '30m',  // Total test duration
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    'http_req_duration{type:register}': ['p(95)<1000'],
    'http_req_duration{type:login}': ['p(95)<500'],
    'http_req_duration{type:todo}': ['p(95)<1000'],
    checks: ['rate>0.9'],
  },
  noConnectionReuse: true,  // Fixes Docker DNS issues
};

// Test data
const AUTH_URL = 'http://auth:8080/auth';
const TODO_URL = 'http://todo:8080/todos';

// Test parameters
const TEST_INTERVAL = 30; // Run test every 30 seconds
const TODO_COUNT = 3;     // Todos to create per test cycle

// Helper function to create a todo
function createTodo(token, cycle, index) {
  return http.post(`${TODO_URL}`, JSON.stringify({
    name: `Test Todo ${cycle}-${index}`,
    description: `This is test todo ${index} from cycle ${cycle} created by k6`,
    priority: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
    dueDate: new Date(Date.now() + 86400000).toISOString(), // Due tomorrow
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    tags: { type: 'todo' }
  });
}

export default function () {
  let testCycle = 0;
  
  while (true) {
    testCycle++;
    const cycleStart = new Date().toISOString();
    console.log(`[VU ${exec.vu.idInTest}] Starting test cycle ${testCycle} at ${cycleStart}`);
    
    // Generate unique user credentials per cycle
    const TEST_USER = {
      username: `user_${testCycle}_${exec.vu.idInTest}`,
      email: `user_${testCycle}_${exec.vu.idInTest}@example.com`,
      password: 'Test123!'
    };

    let token;
    let authSuccess = false;

    // 1. Try to register new user
    const registerRes = http.post(`${AUTH_URL}/register`, JSON.stringify(TEST_USER), {
      headers: { 'Content-Type': 'application/json' },
      tags: { type: 'register' }
    });

    if (registerRes.status === 201) {
      // Registration successful
      token = registerRes.json('token');
      authSuccess = true;
      console.log(`Registered new user: ${TEST_USER.username}`);
    } else if (registerRes.status === 409) {
      // User already exists - try to login
      console.log(`User exists, logging in: ${TEST_USER.username}`);
      const loginRes = http.post(`${AUTH_URL}/login`, JSON.stringify({
        username: TEST_USER.username,
        password: TEST_USER.password
      }), {
        headers: { 'Content-Type': 'application/json' },
        tags: { type: 'login' }
      });

      if (loginRes.status === 200) {
        token = loginRes.json('token');
        authSuccess = true;
      }
    }

    // Verify authentication
    if (!authSuccess || !token) {
      console.error(`Authentication failed for ${TEST_USER.username}`);
      continue;
    }

    // 2. Create todos
    let todosCreated = 0;
    for (let i = 0; i < TODO_COUNT; i++) {
      const todoRes = createTodo(token, testCycle, i);
      
      if (check(todoRes, {
        'todo created': (r) => r.status === 201,
      })) {
        todosCreated++;
      }
      sleep(0.5);
    }

    // 3. Get todos
    const getTodosRes = http.get(`${TODO_URL}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      },
      tags: { type: 'todo' }
    });

    check(getTodosRes, {
      'got todos': (r) => r.status === 200,
      'correct count': (r) => r.json('todos').length >= todosCreated,
    });

    // Calculate sleep time
    const cycleTime = Date.now() - new Date(cycleStart);
    const sleepTime = TEST_INTERVAL - (cycleTime / 1000);
    
    if (sleepTime > 0) {
      console.log(`Cycle ${testCycle} completed, sleeping ${sleepTime.toFixed(1)}s`);
      sleep(sleepTime);
    } else {
      console.log(`Cycle ${testCycle} took too long (${-sleepTime.toFixed(1)}s over), starting next immediately`);
    }
  }
}
