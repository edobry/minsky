import { globSync } from "glob";
import { TestFileAnalyzer } from "../core/analyzer";
import { TestFileTransformer } from "../core/transformer";
import { PatternRegistry } from "../patterns/registry";
import { TransformationPipeline } from "../transformers/pipeline";
import * as fs from "fs";
import * as path from "path";
import { createDiff } from "../utils/diff";

/**
 * Interface for the migrate command options
 */
interface MigrateOptions {
  preview?: boolean;
  safetyLevel?: 'low' | 'medium' | 'high';
  output?: string;
  verbose?: boolean;
}

/**
 * Command to migrate test files to use Bun patterns
 */
export async function migrateCommand(files: string, options: MigrateOptions): Promise<void> {
  try {
    // Find all test files matching the glob pattern
    const testFiles = globSync(files);
    
    if (testFiles.length === 0) {
      console.error(`No files found matching pattern: ${files}`);
      process.exit(1);
    }
    
    if (options.verbose) {
      console.log(`Found ${testFiles.length} files to migrate`);
      console.log(`Safety level: ${options.safetyLevel || 'medium'}`);
      console.log(`Preview mode: ${options.preview ? 'enabled' : 'disabled'}`);
    }
    
    // Initialize the pattern registry with all known patterns
    const registry = new PatternRegistry();
    registry.registerDefaultPatterns();
    
    // Create the analyzer and transformer
    const analyzer = new TestFileAnalyzer(registry);
    const pipeline = new TransformationPipeline();
    
    // Add transformers based on safety level
    pipeline.registerDefaultTransformers(options.safetyLevel || 'medium');
    
    const transformer = new TestFileTransformer(pipeline);
    
    // Results to store all migration data
    const results = [];
    
    // Process each file
    for (const file of testFiles) {
      if (options.verbose) {
        console.log(`Processing ${file}...`);
      }
      
      // First analyze the file
      const analysis = await analyzer.analyzeFile(file);
      
      if (analysis.patterns.length === 0) {
        if (options.verbose) {
          console.log(`No patterns to migrate in ${file}, skipping`);
        }
        continue;
      }
      
      // Read the original content
      const originalContent = fs.readFileSync(file, 'utf8');
      
      // Transform the file
      const { transformedContent, appliedTransformations } = await transformer.transformFile(file, analysis);
      
      // Create a diff
      const diff = createDiff(originalContent, transformedContent);
      
      // Store the results
      results.push({
        file,
        patterns: analysis.patterns,
        appliedTransformations,
        diff
      });
      
      if (options.verbose) {
        console.log(`Applied ${appliedTransformations.length} transformations to ${file}`);
      }
      
      // If not in preview mode, write the transformed content
      if (!options.preview) {
        const outputPath = options.output 
          ? path.resolve(options.output, path.basename(file))
          : file;
          
        fs.writeFileSync(outputPath, transformedContent);
        
        if (options.verbose) {
          console.log(`Transformed content written to ${outputPath}`);
        }
      }
    }
    
    // Output summary
    const summary = {
      totalFiles: testFiles.length,
      transformedFiles: results.length,
      totalTransformations: results.reduce((sum, r) => sum + r.appliedTransformations.length, 0)
    };
    
    console.log(`Migration summary: ${JSON.stringify(summary, null, 2)}`);
    
    // If in preview mode, display diffs
    if (options.preview) {
      console.log("\nPreview of changes:");
      for (const result of results) {
        console.log(`\nFile: ${result.file}`);
        console.log(result.diff);
      }
    }
    
  } catch (error) {
    console.error("Error migrating files:", error);
    process.exit(1);
  }
} 
