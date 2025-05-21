import { Project, SourceFile, SyntaxKind, Node } from "ts-morph";
import { PatternRegistry, MatchedPattern } from "../patterns/registry";

/**
 * Result of analyzing a test file
 */
export interface AnalysisResult {
  /**
   * Array of matched patterns found in the file
   */
  patterns: MatchedPattern[];
  
  /**
   * Overall complexity of migrating this file
   */
  complexity: 'simple' | 'moderate' | 'complex';
  
  /**
   * Map of locations that need transformation
   */
  migrationTargets: {
    [location: string]: {
      patternId: string;
      node: Node;
      originalText: string;
    }
  };
}

/**
 * Class for analyzing test files and identifying patterns that need migration
 */
export class TestFileAnalyzer {
  private project: Project;
  
  /**
   * Create a new TestFileAnalyzer
   * 
   * @param patternRegistry Registry of patterns to identify
   */
  constructor(private patternRegistry: PatternRegistry) {
    this.project = new Project();
  }
  
  /**
   * Analyze a test file to identify patterns that need migration
   * 
   * @param filePath Path to the test file to analyze
   * @returns Analysis result with patterns and migration targets
   */
  async analyzeFile(filePath: string): Promise<AnalysisResult> {
    // Add the file to the project
    const sourceFile = this.project.addSourceFileAtPath(filePath);
    
    // Find all patterns in the file
    const matchedPatterns: MatchedPattern[] = [];
    const migrationTargets: AnalysisResult['migrationTargets'] = {};
    
    // First check for imports
    this.analyzeImports(sourceFile, matchedPatterns, migrationTargets);
    
    // Then analyze function calls and expressions
    this.analyzeFunctionCalls(sourceFile, matchedPatterns, migrationTargets);
    
    // Analyze module mocks
    this.analyzeModuleMocks(sourceFile, matchedPatterns, migrationTargets);
    
    // Analyze assertion patterns
    this.analyzeAssertions(sourceFile, matchedPatterns, migrationTargets);
    
    // Calculate overall complexity based on patterns found
    const complexity = this.calculateComplexity(matchedPatterns);
    
    return {
      patterns: matchedPatterns,
      complexity,
      migrationTargets
    };
  }
  
  /**
   * Analyze import statements in the file
   */
  private analyzeImports(
    sourceFile: SourceFile, 
    matchedPatterns: MatchedPattern[], 
    migrationTargets: AnalysisResult['migrationTargets']
  ): void {
    // Find import declarations
    const importDeclarations = sourceFile.getImportDeclarations();
    
    for (const importDecl of importDeclarations) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const importClause = importDecl.getImportClause();
      
      if (!importClause) continue;
      
      // Check against import patterns
      for (const pattern of this.patternRegistry.getPatterns('import')) {
        const match = pattern.matcher(moduleSpecifier, importDecl);
        
        if (match) {
          const patternId = pattern.id;
          const location = `${importDecl.getStart()}-${importDecl.getEnd()}`;
          const originalText = importDecl.getText();
          
          matchedPatterns.push({
            id: patternId,
            type: 'import',
            location,
            text: originalText
          });
          
          migrationTargets[location] = {
            patternId,
            node: importDecl,
            originalText
          };
          
          break; // Once a pattern matches, move to the next import
        }
      }
    }
  }
  
  /**
   * Analyze function calls in the file
   */
  private analyzeFunctionCalls(
    sourceFile: SourceFile, 
    matchedPatterns: MatchedPattern[], 
    migrationTargets: AnalysisResult['migrationTargets']
  ): void {
    // Find all call expressions
    sourceFile.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const expression = node.getExpression();
        
        // Check against mock function patterns
        for (const pattern of this.patternRegistry.getPatterns('mock-function')) {
          const match = pattern.matcher(node.getText(), node);
          
          if (match) {
            const patternId = pattern.id;
            const location = `${node.getStart()}-${node.getEnd()}`;
            const originalText = node.getText();
            
            matchedPatterns.push({
              id: patternId,
              type: 'mock-function',
              location,
              text: originalText
            });
            
            migrationTargets[location] = {
              patternId,
              node,
              originalText
            };
            
            break; // Once a pattern matches, move to the next call
          }
        }
      }
    });
  }
  
  /**
   * Analyze module mocks in the file
   */
  private analyzeModuleMocks(
    sourceFile: SourceFile, 
    matchedPatterns: MatchedPattern[], 
    migrationTargets: AnalysisResult['migrationTargets']
  ): void {
    // Find calls that match module mock patterns
    sourceFile.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        // Check against module mock patterns
        for (const pattern of this.patternRegistry.getPatterns('module-mock')) {
          const match = pattern.matcher(node.getText(), node);
          
          if (match) {
            const patternId = pattern.id;
            const location = `${node.getStart()}-${node.getEnd()}`;
            const originalText = node.getText();
            
            matchedPatterns.push({
              id: patternId,
              type: 'module-mock',
              location,
              text: originalText
            });
            
            migrationTargets[location] = {
              patternId,
              node,
              originalText
            };
            
            break; // Once a pattern matches, move to the next call
          }
        }
      }
    });
  }
  
  /**
   * Analyze assertion patterns in the file
   */
  private analyzeAssertions(
    sourceFile: SourceFile, 
    matchedPatterns: MatchedPattern[], 
    migrationTargets: AnalysisResult['migrationTargets']
  ): void {
    // Find assertions (typically expressions with expect)
    sourceFile.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        // Check against assertion patterns
        for (const pattern of this.patternRegistry.getPatterns('assertion')) {
          const match = pattern.matcher(node.getText(), node);
          
          if (match) {
            const patternId = pattern.id;
            const location = `${node.getStart()}-${node.getEnd()}`;
            const originalText = node.getText();
            
            matchedPatterns.push({
              id: patternId,
              type: 'assertion',
              location,
              text: originalText
            });
            
            migrationTargets[location] = {
              patternId,
              node,
              originalText
            };
            
            break; // Once a pattern matches, move to the next call
          }
        }
      }
    });
  }
  
  /**
   * Calculate the overall complexity of migrating this file
   */
  private calculateComplexity(matchedPatterns: MatchedPattern[]): 'simple' | 'moderate' | 'complex' {
    // Count patterns by type
    const counts = {
      import: 0,
      'mock-function': 0,
      'module-mock': 0,
      assertion: 0,
      other: 0
    };
    
    for (const pattern of matchedPatterns) {
      if (pattern.type in counts) {
        counts[pattern.type as keyof typeof counts]++;
      } else {
        counts.other++;
      }
    }
    
    // Complex if it has module mocks or more than 10 patterns
    if (counts['module-mock'] > 0 || matchedPatterns.length > 10) {
      return 'complex';
    }
    
    // Moderate if it has mock functions or 5-10 patterns
    if (counts['mock-function'] > 0 || matchedPatterns.length >= 5) {
      return 'moderate';
    }
    
    // Otherwise simple
    return 'simple';
  }
} 
