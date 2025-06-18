import { initializeFaro, getWebInstrumentations } from 'https://esm.sh/@grafana/faro-web-sdk@1.3.5';
import { TracingInstrumentation } from 'https://esm.sh/@grafana/faro-web-tracing@1.3.5';

// Initialize Faro with web instrumentations and tracing
const faro = initializeFaro({
  url: 'http://localhost:12346/collect',
  app: {
    name: 'frontend',
    version: '1.0.0',
  },
  instrumentations: [
    ...getWebInstrumentations(),
    new TracingInstrumentation({
      instrumentationOptions: {
        propagateTraceHeaderCorsUrls: [/.*/],
      },
    }),
  ],
});

// Get OTel trace and context APIs
const { trace, context } = faro.api.getOTEL();

// API URLs
const AUTH_URL = 'http://localhost:8083';
const TODO_URL = 'http://localhost:8081';

// Initialize date pickers
flatpickr("#todoDueDate", {
  enableTime: true,
  dateFormat: "Y-m-d H:i",
});

flatpickr("#todoReminderDate", {
  enableTime: true,
  dateFormat: "Y-m-d H:i",
});

// Auth state management
let authToken = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user'));

// Make logout function globally available
window.logout = function() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  authToken = null;
  currentUser = null;
  updateAuthState();
};

// Show/hide containers based on auth state
function updateAuthState() {
  const authContainer = document.getElementById('authContainer');
  const registerContainer = document.getElementById('registerContainer');
  const todoContainer = document.getElementById('todoContainer');

  if (authToken) {
    authContainer.classList.add('hidden');
    registerContainer.classList.add('hidden');
    todoContainer.classList.remove('hidden');
    fetchTodos();
  } else {
    authContainer.classList.remove('hidden');
    registerContainer.classList.add('hidden');
    todoContainer.classList.add('hidden');
  }
}

// Auth form handlers
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tracer = trace.getTracer('auth');
  const span = tracer.startSpan('login');

  try {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    const response = await fetch(`${AUTH_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    if (response.ok) {
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('token', authToken);
      localStorage.setItem('user', JSON.stringify(currentUser));
      updateAuthState();
      span.setAttribute('login.status', 'success');
    } else {
      alert(data.error);
      span.setAttribute('login.status', 'failed');
    }
  } catch (error) {
    console.error('Login error:', error);
    alert('Error logging in');
    span.recordException(error);
  }
  span.end();
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tracer = trace.getTracer('auth');
  const span = tracer.startSpan('register');

  try {
    const username = document.getElementById('regUsername').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;

    const response = await fetch(`${AUTH_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });

    const data = await response.json();
    if (response.ok) {
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('token', authToken);
      localStorage.setItem('user', JSON.stringify(currentUser));
      updateAuthState();
      span.setAttribute('register.status', 'success');
    } else {
      alert(data.error);
      span.setAttribute('register.status', 'failed');
    }
  } catch (error) {
    console.error('Registration error:', error);
    alert('Error registering');
    span.recordException(error);
  }
  span.end();
});

// Todo form handler
document.getElementById('todoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tracer = trace.getTracer('todos');
  const span = tracer.startSpan('create_todo');

  try {
    const name = document.getElementById('todoName').value.trim();
    const description = document.getElementById('todoDescription').value.trim();
    const dueDate = document.getElementById('todoDueDate').value;
    const reminderDate = document.getElementById('todoReminderDate').value;
    const priority = document.getElementById('todoPriority').value;

    // Validate required fields
    if (!name) {
      alert('Todo name is required');
      span.setAttribute('todo.create.status', 'validation_error');
      span.end();
      return;
    }

    // Prepare the request body
    const todoData = {
      name,
      description: description || undefined,
      priority
    };

    // Only add dates if they are set
    if (dueDate) {
      const dueDateObj = new Date(dueDate);
      if (isNaN(dueDateObj.getTime())) {
        alert('Invalid due date format');
        span.setAttribute('todo.create.status', 'validation_error');
        span.end();
        return;
      }
      todoData.dueDate = dueDateObj.toISOString();
    }

    if (reminderDate) {
      const reminderDateObj = new Date(reminderDate);
      if (isNaN(reminderDateObj.getTime())) {
        alert('Invalid reminder date format');
        span.setAttribute('todo.create.status', 'validation_error');
        span.end();
        return;
      }
      todoData.reminderDate = reminderDateObj.toISOString();
    }

    console.log('Sending todo data:', todoData);

    const response = await fetch(`${TODO_URL}/todos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(todoData)
    });

    const data = await response.json();

    if (response.ok) {
      document.getElementById('todoForm').reset();
      fetchTodos();
      span.setAttribute('todo.create.status', 'success');
    } else {
      // Show detailed error message
      if (data.details && Array.isArray(data.details)) {
        alert(data.details.join('\n'));
      } else {
        alert(data.error || 'Error creating todo');
      }
      span.setAttribute('todo.create.status', 'failed');
      span.setAttribute('error.message', data.error);
    }
  } catch (error) {
    console.error('Error creating todo:', error);
    alert('Error creating todo. Please try again.');
    span.recordException(error);
  }
  span.end();
});

// Fetch and display todos
async function fetchTodos() {
  const tracer = trace.getTracer('todos');
  const span = tracer.startSpan('fetch_todos');

  try {
    const response = await fetch(`${TODO_URL}/todos`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (response.ok) {
      const data = await response.json();
      const tbody = document.getElementById('todosBody');
      tbody.innerHTML = '';

      data.todos.forEach(todo => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${todo.name}</td>
          <td>${todo.description || ''}</td>
          <td>${todo.dueDate ? new Date(todo.dueDate).toLocaleString() : ''}</td>
          <td class="priority-${todo.priority}">${todo.priority}</td>
          <td>
            <input type="checkbox" ${todo.completed ? 'checked' : ''} 
              onchange="updateTodoStatus('${todo._id}', this.checked)">
          </td>
          <td>
            <button onclick="deleteTodo('${todo._id}')" class="btn btn-danger">Delete</button>
          </td>
        `;
        tbody.appendChild(row);
      });
      span.setAttribute('todo.count', data.todos.length);
    } else {
      const data = await response.json();
      if (response.status === 401) {
        // Token expired or invalid
        logout();
      } else {
        alert(data.error);
      }
    }
  } catch (error) {
    console.error('Error fetching todos:', error);
    span.recordException(error);
  }
  span.end();
}

// Update todo status
window.updateTodoStatus = async (todoId, completed) => {
  const tracer = trace.getTracer('todos');
  const span = tracer.startSpan('update_todo');

  try {
    const response = await fetch(`${TODO_URL}/todos/${todoId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ completed })
    });

    if (!response.ok) {
      const data = await response.json();
      alert(data.error);
      fetchTodos(); // Refresh to show correct state
    }
  } catch (error) {
    console.error('Error updating todo:', error);
    alert('Error updating todo');
    span.recordException(error);
  }
  span.end();
};

// Delete todo
window.deleteTodo = async (todoId) => {
  const tracer = trace.getTracer('todos');
  const span = tracer.startSpan('delete_todo');

  if (confirm('Are you sure you want to delete this todo?')) {
    try {
      const response = await fetch(`${TODO_URL}/todos/${todoId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });

      if (response.ok) {
        fetchTodos();
      } else {
        const data = await response.json();
        alert(data.error);
      }
    } catch (error) {
      console.error('Error deleting todo:', error);
      alert('Error deleting todo');
      span.recordException(error);
    }
  }
  span.end();
};

// Auth navigation
document.getElementById('showRegister').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('authContainer').classList.add('hidden');
  document.getElementById('registerContainer').classList.remove('hidden');
});

document.getElementById('showLogin').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('registerContainer').classList.add('hidden');
  document.getElementById('authContainer').classList.remove('hidden');
});

// Initialize app
updateAuthState();