import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../db.js";

await connectDB();
await mongoose.connection.db.admin().ping();
console.log("Atlas / MongoDB connection verified.");
await mongoose.disconnect();
process.exit(0);
