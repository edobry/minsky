import * as diffLib from 'diff';
import chalk from 'chalk';

/**
 * Create a diff between original and transformed content
 * 
 * @param originalContent Original file content
 * @param transformedContent Transformed file content
 * @returns Colorized diff string
 */
export function createDiff(originalContent: string, transformedContent: string): string {
  const diffParts = diffLib.diffLines(originalContent, transformedContent);
  let diffOutput = '';
  
  for (const part of diffParts) {
    // Skip unchanged parts
    if (!part.added && !part.removed) {
      // Show a bit of context around changes
      const lines = part.value.split('\n');
      const maxContextLines = 2;
      
      if (lines.length > maxContextLines * 2 + 1) {
        // Add first few lines
        for (let i = 0; i < maxContextLines; i++) {
          if (lines[i]) {
            diffOutput += `  ${lines[i]}\n`;
          }
        }
        
        // Add ellipsis
        diffOutput += '  ...\n';
        
        // Add last few lines
        for (let i = lines.length - maxContextLines; i < lines.length; i++) {
          if (lines[i]) {
            diffOutput += `  ${lines[i]}\n`;
          }
        }
      } else {
        // Add all lines if it's a small context block
        for (const line of lines) {
          diffOutput += `  ${line}\n`;
        }
      }
      continue;
    }
    
    // Added lines (green)
    if (part.added) {
      const lines = part.value.split('\n');
      for (const line of lines) {
        if (line) {
          diffOutput += chalk.green(`+ ${line}\n`);
        }
      }
    }
    
    // Removed lines (red)
    if (part.removed) {
      const lines = part.value.split('\n');
      for (const line of lines) {
        if (line) {
          diffOutput += chalk.red(`- ${line}\n`);
        }
      }
    }
  }
  
  return diffOutput;
}

/**
 * Create a simple HTML diff for visualization
 * 
 * @param originalContent Original file content
 * @param transformedContent Transformed file content
 * @returns HTML diff string
 */
export function createHtmlDiff(originalContent: string, transformedContent: string): string {
  const diff = diffLib.diffLines(originalContent, transformedContent);
  let html = '<div class="diff">\n';
  
  diff.forEach((part) => {
    // Format the part based on whether it's added, removed, or unchanged
    const cssClass = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    
    // Add the part to the HTML with appropriate styling
    html += `<div class="${cssClass}">`;
    const lines = part.value.split('\n');
    for (const line of lines) {
      if (line) {
        html += `<pre>${prefix} ${escapeHtml(line)}</pre>\n`;
      }
    }
    html += '</div>\n';
  });
  
  html += '</div>';
  return html;
}

/**
 * Escape HTML special characters
 * 
 * @param str String to escape
 * @returns Escaped string
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
} 
