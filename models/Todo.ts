import mongoose, { Schema, Document } from 'mongoose';
import start from '../tracer';

const { logger } = start('todo-model');

interface ITodoDocument extends Document {
  name: string;
  description?: string;
  userId: mongoose.Types.ObjectId;
  completed: boolean;
  dueDate?: Date;
  reminderDate?: Date;
  priority: 'low' | 'medium' | 'high';
}

export interface ITodo extends ITodoDocument {}

const todoSchema = new Schema({
  name: {
    type: String,
    required: [true, 'Todo name is required'],
    trim: true,
    maxlength: [200, 'Todo name cannot exceed 200 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  completed: {
    type: Boolean,
    default: false
  },
  dueDate: {
    type: Date,
    validate: [{
      validator: function(this: ITodo, value: Date): boolean {
        if (!value) return true; // Allow null/undefined
        return value > new Date();
      },
      message: 'Due date must be in the future'
    }]
  },
  reminderDate: {
    type: Date,
    validate: [{
      validator: function(this: ITodo, value: Date): boolean {
        if (!value) return true; // Allow null/undefined
        if (!this.dueDate) return true; // Allow if no due date is set
        return value <= this.dueDate;
      },
      message: 'Reminder date must be before or equal to due date'
    }]
  },
  priority: {
    type: String,
    enum: {
      values: ['low', 'medium', 'high'],
      message: '{VALUE} is not a valid priority level'
    },
    default: 'medium'
  }
}, {
  timestamps: true
});

// Create indexes
todoSchema.index({ userId: 1, completed: 1 });
todoSchema.index({ dueDate: 1 }, { sparse: true });
todoSchema.index({ reminderDate: 1 }, { sparse: true });

export const Todo = mongoose.model<ITodo>('Todo', todoSchema); 