import { Node, SourceFile } from "ts-morph";
import { JestImportTransformer } from "./import-transformers";
import { JestMockFunctionTransformer, ViMockFunctionTransformer } from "./mock-function-transformers";
import { JestModuleMockTransformer, ViModuleMockTransformer } from "./module-mock-transformers";
import { AssertionTransformer } from "./assertion-transformers";

/**
 * Interface for a transformer that can transform a pattern
 */
export interface Transformer {
  /**
   * ID of the pattern this transformer can handle
   */
  patternId: string;
  
  /**
   * Priority of this transformer (higher values run first)
   */
  priority: number;
  
  /**
   * Transform a pattern
   * 
   * @param text Original text of the pattern
   * @param node AST node of the pattern
   * @param sourceFile Source file containing the pattern
   * @returns Transformed text
   */
  transform(text: string, node: Node, sourceFile: SourceFile): Promise<string>;
  
  /**
   * Safety level at which this transformer is active
   */
  safetyLevel: 'low' | 'medium' | 'high';
}

/**
 * Transformation pipeline that manages transformers for different patterns
 */
export class TransformationPipeline {
  private transformers: Map<string, Transformer[]> = new Map();
  private currentSafetyLevel: 'low' | 'medium' | 'high' = 'medium';
  
  /**
   * Register a transformer for a pattern
   * 
   * @param transformer Transformer to register
   */
  registerTransformer(transformer: Transformer): void {
    const transformers = this.transformers.get(transformer.patternId) || [];
    transformers.push(transformer);
    transformers.sort((a, b) => b.priority - a.priority); // Sort by priority
    this.transformers.set(transformer.patternId, transformers);
  }
  
  /**
   * Get a transformer for a pattern
   * 
   * @param patternId ID of the pattern
   * @returns Transformer if one exists for this pattern and safety level
   */
  getTransformerForPattern(patternId: string): Transformer | undefined {
    const transformers = this.transformers.get(patternId) || [];
    
    // Find the first transformer that matches the safety level
    return transformers.find(t => this.isTransformerActive(t));
  }
  
  /**
   * Check if a transformer is active at the current safety level
   * 
   * @param transformer Transformer to check
   * @returns True if the transformer is active
   */
  private isTransformerActive(transformer: Transformer): boolean {
    // Safety levels: low (most aggressive), medium, high (most conservative)
    const safetyLevels = { low: 0, medium: 1, high: 2 };
    
    // Transformer is active if its safety level is higher or equal to the current one
    return safetyLevels[transformer.safetyLevel] <= safetyLevels[this.currentSafetyLevel];
  }
  
  /**
   * Set the safety level for transformations
   * 
   * @param level Safety level (low, medium, high)
   */
  setSafetyLevel(level: 'low' | 'medium' | 'high'): void {
    this.currentSafetyLevel = level;
  }
  
  /**
   * Register default transformers for different patterns
   * 
   * @param safetyLevel Safety level to use
   */
  registerDefaultTransformers(safetyLevel: 'low' | 'medium' | 'high' = 'medium'): void {
    this.setSafetyLevel(safetyLevel);
    
    // Import transformers
    this.registerTransformer(new JestImportTransformer());
    
    // Mock function transformers
    this.registerTransformer(new JestMockFunctionTransformer());
    this.registerTransformer(new ViMockFunctionTransformer());
    
    // Module mock transformers
    if (safetyLevel !== 'high') {
      // Only register these for lower safety levels
      this.registerTransformer(new JestModuleMockTransformer());
      this.registerTransformer(new ViModuleMockTransformer());
    }
    
    // Assertion transformers
    this.registerTransformer(new AssertionTransformer());
  }
} 
