# Task Backend Architecture Analysis

## Executive Summary

This document presents a comprehensive analysis of Minsky's task backend architecture, examining the fundamental tension between in-tree (git-native) and database-backed storage approaches. As a distributed systems engineer, I approach this problem recognizing that we're essentially evaluating whether to build a distributed database on top of git or embrace traditional centralized database solutions.

**Key Finding**: The in-tree backend approach, while philosophically elegant, represents an attempt to build a distributed database without acknowledging the inherent complexity of distributed systems. This analysis will demonstrate why this path leads to unnecessary complexity for marginal benefits.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current Implementation Analysis](#current-implementation-analysis)
3. [Distributed Systems Perspective](#distributed-systems-perspective)
4. [In-tree Backend Deep Dive](#in-tree-backend-deep-dive)
5. [Database Backend Analysis](#database-backend-analysis)
6. [Cross-Repository Challenges](#cross-repository-challenges)
7. [Architectural Tradeoffs](#architectural-tradeoffs)
8. [Recommendation](#recommendation)

## Problem Statement

Minsky faces a critical architectural decision regarding how to store and manage task metadata:

1. **In-tree backends**: Store task data as markdown/json files within the git repository
2. **Database backends**: Use traditional databases (SQLite, PostgreSQL) for task storage

The current implementation uses a "special workspace" mechanism to support in-tree backends, which has proven to be:

- Complex to implement and maintain
- Brittle in distributed team scenarios
- Essentially a naive implementation of a distributed database

### Core Questions to Answer

1. Is the philosophical elegance of git-native storage worth the implementation complexity?
2. Are we solving a real decentralization requirement, or creating unnecessary complexity?
3. How do cross-repository workflows impact the viability of in-tree backends?
4. What is the right architecture for different user personas and scale points?

## Current Implementation Analysis

The special workspace mechanism represents the current attempt to reconcile in-tree storage with the need for centralized task visibility. Let me analyze its complexity and failure modes...
