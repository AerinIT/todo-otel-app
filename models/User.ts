import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import start from '../tracer';

const { logger } = start('user-model');

interface IUserDocument extends mongoose.Document {
  _id: mongoose.Types.ObjectId;
  username: string;
  email: string;
  password: string;
}

export interface IUser extends IUserDocument {
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters long'],
    maxlength: [30, 'Username cannot exceed 30 characters'],
    match: [/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores and hyphens']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email address']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    maxlength: [128, 'Password cannot exceed 128 characters'],
    validate: {
      validator: function(v: string) {
        // At least one uppercase, one lowercase, one number
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/.test(v);
      },
      message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    }
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(this: IUser, next) {
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(this.password, salt);
    this.password = hashedPassword;
    next();
  } catch (error: any) {
    logger.emit({
      severityText: 'ERROR',
      body: 'Error hashing password',
      attributes: {
        error: error.message
      }
    });
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(this: IUser, candidatePassword: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error: any) {
    logger.emit({
      severityText: 'ERROR',
      body: 'Error comparing password',
      attributes: {
        error: error.message
      }
    });
    throw error;
  }
};

// Create indexes
userSchema.index({ username: 1 });
userSchema.index({ email: 1 });

export const User = mongoose.model<IUser>('User', userSchema); 