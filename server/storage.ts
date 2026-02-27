import { type User, type InsertUser } from "@shared/schema";
import { randomUUID } from "crypto";

// modify the interface with any CRUD methods
// you might need

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;

  constructor() {
    this.users = new Map();
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const normalized = username.toLowerCase();
    return Array.from(this.users.values()).find(
      (user) => user.email.toLowerCase() === normalized,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const now = new Date();
    const user: User = {
      id,
      email: insertUser.email,
      fullName: insertUser.fullName,
      role: insertUser.role,
      isActive: insertUser.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, user);
    return user;
  }
}

export const storage = new MemStorage();
