import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Test configuration
export const options = {
  scenarios: {
    // Single user flow
    single_user: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30s',
    },
    // Multiple users creating todos
    multiple_users: {
      executor: 'per-vu-iterations',
      vus: 3,
      iterations: 2,
      maxDuration: '30s',
      startTime: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 95% of requests should be below 2s
    'http_req_duration{type:register}': ['p(95)<1000'],
    'http_req_duration{type:login}': ['p(95)<500'],
    'http_req_duration{type:todo}': ['p(95)<1000'],
  },
};

// Test data
const AUTH_URL = 'http://<YOUR-PUBLIC-IP>:8083/auth';
const TODO_URL = 'http://<YOUR-PUBLIC-IP>:8081/todos';

// Fixed test user credentials
const TEST_USER = {
  username: 'testuser',
  email: 'test@example.com',
  password: 'Test123!'
};

// Helper function to create a todo
function createTodo(token, index) {
  return http.post(`${TODO_URL}`, JSON.stringify({
    name: `Test Todo ${index}`,
    description: `This is test todo ${index} created by k6`,
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
  let token;

  // Try to login first
  const loginRes = http.post(`${AUTH_URL}/login`, JSON.stringify({
    username: TEST_USER.username,
    password: TEST_USER.password
  }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { type: 'login' }
  });

  // If login fails, try to register
  if (loginRes.status !== 200) {
    const registerRes = http.post(`${AUTH_URL}/register`, JSON.stringify(TEST_USER), {
      headers: { 'Content-Type': 'application/json' },
      tags: { type: 'register' }
    });

    check(registerRes, {
      'register successful': (r) => r.status === 201 || r.status === 409, // 409 means user already exists
      'register has token or user exists': (r) => r.json('token') !== undefined || r.status === 409,
    });

    if (registerRes.status === 201) {
      token = registerRes.json('token');
    } else {
      // If registration failed because user exists, try login again
      const retryLoginRes = http.post(`${AUTH_URL}/login`, JSON.stringify({
        username: TEST_USER.username,
        password: TEST_USER.password
      }), {
        headers: { 'Content-Type': 'application/json' },
        tags: { type: 'login' }
      });
      token = retryLoginRes.json('token');
    }
  } else {
    token = loginRes.json('token');
  }

  check(loginRes, {
    'login successful': (r) => r.status === 200,
    'login has token': (r) => r.json('token') !== undefined,
  });

  sleep(1);

  // Create multiple todos
  const todoCount = 3;
  for (let i = 0; i < todoCount; i++) {
    const todoRes = createTodo(token, i);
    
    check(todoRes, {
      'todo creation successful': (r) => r.status === 201,
      'todo has id': (r) => r.json('_id') !== undefined,
      'todo has correct name': (r) => r.json('name') === `Test Todo ${i}`,
    });

    sleep(0.5);
  }

  // Get all todos
  const getTodosRes = http.get(`${TODO_URL}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    },
    tags: { type: 'todo' }
  });

  check(getTodosRes, {
    'get todos successful': (r) => r.status === 200,
    'has todos': (r) => r.json('todos') !== undefined,
  });
}
