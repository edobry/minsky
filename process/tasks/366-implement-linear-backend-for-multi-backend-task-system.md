# Implement Linear Backend for Multi-Backend Task System

## Context

Implement a comprehensive Linear backend for the multi-backend task system, enabling seamless integration with Linear issues as tasks using qualified task IDs (linear#ABC-123). This validates the multi-backend architecture with a third-party API and provides teams using Linear with native task management capabilities.

## Context

Linear is a popular issue tracking and project management tool with excellent API support. Many development teams use Linear for sprint planning, issue tracking, and project management. Adding Linear backend support would demonstrate the flexibility of our multi-backend architecture and provide immediate value to Linear-using teams.

## Objectives

### Primary Goal
Implement a production-ready Linear backend that seamlessly integrates with the multi-backend task system, providing full CRUD operations, status synchronization, and native Linear issue management.

### Success Criteria
1. Complete TaskBackend Implementation: Full implementation of the TaskBackend interface with Linear API integration
2. Qualified Task IDs: Support for linear#ABC-123 format with automatic ID extraction from Linear issue identifiers
3. Status Synchronization: Bidirectional status mapping between Minsky task statuses and Linear issue states
4. Team/Project Support: Handle Linear teams and projects with proper scope isolation
5. Real-time Operations: Create, read, update, delete operations that sync immediately with Linear
6. Authentication: Secure API key management with proper token validation
7. Error Handling: Robust error handling using the multi-backend error system from Task #356

## Technical Requirements

### 1. Linear Backend Implementation

Implement LinearTaskBackend class with complete TaskBackend interface.

### 2. Linear API Integration

Linear GraphQL API: Linear uses GraphQL for all operations
- Authentication: Personal API tokens or OAuth
- Issue Operations: Create, read, update, archive issues
- Team Scope: Issues belong to teams (required)
- Project Association: Issues can be associated with projects (optional)
- Status Management: Linear workflow states mapped to Minsky statuses

### 3. Task ID Management

Format: linear#ABC-123 where linear = backend prefix and ABC-123 = Linear issue identifier (team prefix + issue number)

### 4. Status Mapping

Map Linear workflow states to Minsky task statuses (unstarted->TODO, started->IN-PROGRESS, completed->DONE, canceled->CLOSED)

## Implementation Plan

### Phase 1: Core Backend Structure (4-5 hours)
1. Linear API Client Setup
2. TaskBackend Interface Implementation

### Phase 2: Task Operations (6-8 hours)  
1. CRUD Operations
2. Task ID Management

### Phase 3: Advanced Features (4-5 hours)
1. Status Synchronization
2. Team and Project Support

### Phase 4: Integration and Testing (3-4 hours)
1. Multi-Backend Integration
2. Comprehensive Testing

## Dependencies
- Task #356: Multi-backend task system architecture (completed)
- Task #357: Repository backend integration (helpful but not blocking)

## Effort Estimate
Large (16-20 hours)

## Priority
MEDIUM - Extends multi-backend architecture with popular project management integration

## Requirements

## Solution

## Notes
