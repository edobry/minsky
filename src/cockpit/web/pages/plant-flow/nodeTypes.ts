import { GestureEdge } from "../../components/GestureEdge";
import { S5IdentityNode, S4FutureNode, S3ManagementNode } from "./PolicyNodes";
import {
  S1TasksNode,
  S1ReadyNode,
  S1SessionsNode,
  S1AgentsNode,
  S1PRNode,
  S1ReviewNode,
  S1DoneNode,
} from "./StageNodes";
import { AttentionSeamNode, LearningLoopNode, InfraSupplyNode, S2ValveNode } from "./SupportNodes";

/**
 * Node/edge type registries for PlantFlowPage's react-flow canvas (mt#2598
 * split — extracted verbatim from PlantFlowPage.tsx's "Node type registry"
 * section). Maps the type strings used in plant-flow/layout.ts's node
 * literals and plant-flow/edges.ts's edge literals to their components.
 */

/** Node type registry — maps type strings to components */
export const nodeTypes = {
  "s5-identity": S5IdentityNode,
  "s4-future": S4FutureNode,
  "s3-management": S3ManagementNode,
  "s2-valve": S2ValveNode,
  "s1-tasks": S1TasksNode,
  "s1-ready": S1ReadyNode,
  "s1-sessions": S1SessionsNode,
  "s1-agents": S1AgentsNode,
  "s1-pr": S1PRNode,
  "s1-review": S1ReviewNode,
  "s1-done": S1DoneNode,
  "attention-seam": AttentionSeamNode,
  "learning-loop": LearningLoopNode,
  "infra-supply": InfraSupplyNode,
} as const;

/** Custom edge types — "gesture" renders the event-driven traveling dot. */
export const edgeTypes = {
  gesture: GestureEdge,
} as const;
