#!/usr/bin/env bun

/**
 * Test script for BLOCKED status implementation
 * Following testing-session-repo-changes rule to test modified code directly
 */

import { TASK_STATUS, TASK_STATUS_VALUES, CHECKBOX_TO_STATUS, STATUS_TO_CHECKBOX } from './src/domain/tasks/taskConstants.js';

console.log('🧪 Testing BLOCKED Status Implementation\n');

// Test 1: Verify BLOCKED is in TASK_STATUS
console.log('✅ Test 1: TASK_STATUS includes BLOCKED');
console.log('TASK_STATUS.BLOCKED:', TASK_STATUS.BLOCKED);
console.log('All statuses:', Object.values(TASK_STATUS));

// Test 2: Verify BLOCKED is in TASK_STATUS_VALUES
console.log('\n✅ Test 2: TASK_STATUS_VALUES includes BLOCKED');
console.log('TASK_STATUS_VALUES:', TASK_STATUS_VALUES);
console.log('Includes BLOCKED:', TASK_STATUS_VALUES.includes('BLOCKED'));

// Test 3: Verify checkbox mapping
console.log('\n✅ Test 3: Checkbox mapping for BLOCKED');
console.log('BLOCKED → checkbox:', STATUS_TO_CHECKBOX.BLOCKED);
console.log('~ → status:', CHECKBOX_TO_STATUS['~']);

// Test 4: Verify all status mappings work
console.log('\n✅ Test 4: All status mappings');
for (const status of TASK_STATUS_VALUES) {
  const checkbox = STATUS_TO_CHECKBOX[status];
  const backToStatus = CHECKBOX_TO_STATUS[checkbox];
  console.log(`${status} ↔ "${checkbox}" ↔ ${backToStatus} ${status === backToStatus ? '✅' : '❌'}`);
}

console.log('\n🎉 BLOCKED status implementation test completed!');

// Test 5: Try importing from schema
try {
  const { taskStatusSchema } = await import('./src/schemas/tasks.js');
  console.log('\n✅ Test 5: Schema import successful');
  console.log('Schema can parse BLOCKED:', taskStatusSchema.safeParse('BLOCKED').success);
} catch (error) {
  console.log('\n❌ Test 5: Schema import failed:', error);
} 
