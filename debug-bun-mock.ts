#!/usr/bin/env bun
import { mock, jest } from "bun:test";

console.log("mock:", Object.keys(mock));
console.log("jest available:", !!jest);
if (jest) {
  console.log("jest:", Object.keys(jest));
} 
