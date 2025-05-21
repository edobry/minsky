import { Project, SourceFile, Node } from "ts-morph";
import { AnalysisResult } from "./analyzer";
import { TransformationPipeline } from "../transformers/pipeline";

/**
 * Applied transformation details
 */
export interface AppliedTransformation {
  /**
   * ID of the pattern that was transformed
   */
  patternId: string;
  
  /**
   * Location of the transformation
   */
  location: string;
  
  /**
   * Original text before transformation
   */
  originalText: string;
  
  /**
   * Transformed text
   */
  transformedText: string;
}

/**
 * Result of transforming a file
 */
export interface TransformationResult {
  /**
   * Transformed content
   */
  transformedContent: string;
  
  /**
   * List of applied transformations
   */
  appliedTransformations: AppliedTransformation[];
  
  /**
   * Any validation issues
   */
  issues?: string[];
}

/**
 * Class for transforming test files by applying transformations to identified patterns
 */
export class TestFileTransformer {
  private project: Project;
  
  /**
   * Create a new TestFileTransformer
   * 
   * @param pipeline Transformation pipeline to use
   */
  constructor(private pipeline: TransformationPipeline) {
    this.project = new Project();
  }
  
  /**
   * Transform a test file by applying transformations to identified patterns
   * 
   * @param filePath Path to the test file to transform
   * @param analysis Analysis result with identified patterns
   * @returns Transformation result with transformed content
   */
  async transformFile(filePath: string, analysis: AnalysisResult): Promise<TransformationResult> {
    // Add the file to the project
    const sourceFile = this.project.addSourceFileAtPath(filePath);
    
    // Sort locations in reverse order to avoid invalidating locations
    const locations = Object.keys(analysis.migrationTargets).sort((a, b) => {
      const [aStart] = a.split('-').map(Number);
      const [bStart] = b.split('-').map(Number);
      return bStart - aStart; // Reverse order
    });
    
    // Applied transformations
    const appliedTransformations: AppliedTransformation[] = [];
    
    // Process each target location
    for (const location of locations) {
      const target = analysis.migrationTargets[location];
      
      // Find a transformer for this pattern
      const transformer = this.pipeline.getTransformerForPattern(target.patternId);
      
      if (transformer) {
        try {
          // Create a copy of the node at this location
          const nodeText = target.originalText;
          
          // Apply the transformation
          const transformedText = await transformer.transform(nodeText, target.node, sourceFile);
          
          if (transformedText !== nodeText) {
            // Replace the node with the transformed text
            const [start, end] = location.split('-').map(Number);
            sourceFile.replaceText([start, end - start], transformedText);
            
            // Record the transformation
            appliedTransformations.push({
              patternId: target.patternId,
              location,
              originalText: nodeText,
              transformedText
            });
          }
        } catch (error) {
          console.error(`Error transforming pattern ${target.patternId} at ${location}:`, error);
        }
      }
    }
    
    // Format the file
    try {
      await sourceFile.formatText();
    } catch (error) {
      console.warn("Error formatting file:", error);
    }
    
    // Get the transformed content
    const transformedContent = sourceFile.getFullText();
    
    // Check for validation issues
    const issues = this.validateTransformedContent(transformedContent);
    
    return {
      transformedContent,
      appliedTransformations,
      issues
    };
  }
  
  /**
   * Validate the transformed content for syntax errors
   * 
   * @param content Transformed content
   * @returns Array of validation issues, or undefined if no issues
   */
  private validateTransformedContent(content: string): string[] | undefined {
    try {
      // Create a temporary project and add the transformed content
      const project = new Project();
      const sourceFile = project.createSourceFile('temp.ts', content);
      
      // Get any diagnostics
      const diagnostics = sourceFile.getPreEmitDiagnostics();
      
      if (diagnostics.length > 0) {
        return diagnostics.map(d => d.getMessageText().toString());
      }
      
      return undefined;
    } catch (error) {
      return [`Validation error: ${error.message}`];
    }
  }
} 
