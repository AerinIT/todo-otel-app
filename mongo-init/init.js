// Switch to the todo-app database
db = db.getSiblingDB('todo-app');

// Create collections with schema validation
db.createCollection('users', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['username', 'email', 'password'],
      properties: {
        username: {
          bsonType: 'string',
          description: 'must be a string and is required'
        },
        email: {
          bsonType: 'string',
          pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
          description: 'must be a valid email address and is required'
        },
        password: {
          bsonType: 'string',
          description: 'must be a string and is required'
        }
      }
    }
  }
});

db.createCollection('todos', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['userId', 'name'],
      properties: {
        userId: {
          bsonType: 'objectId',
          description: 'must be an ObjectId and is required'
        },
        name: {
          bsonType: 'string',
          description: 'must be a string and is required'
        },
        completed: {
          bsonType: 'bool',
          description: 'must be a boolean'
        },
        dueDate: {
          bsonType: ['date', 'null'],
          description: 'must be a date if present'
        },
        reminderDate: {
          bsonType: ['date', 'null'],
          description: 'must be a date if present'
        },
        priority: {
          enum: ['low', 'medium', 'high'],
          description: 'can only be one of the enum values'
        },
        description: {
          bsonType: 'string',
          description: 'must be a string if present'
        }
      }
    }
  }
});

// Create indexes
db.users.createIndex({ "username": 1 }, { unique: true });
db.users.createIndex({ "email": 1 }, { unique: true });

db.todos.createIndex({ "userId": 1 });
db.todos.createIndex({ "dueDate": 1 });
db.todos.createIndex({ "userId": 1, "completed": 1 }); 