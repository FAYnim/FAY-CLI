/**
 * Tool Partitioner for Parallel and Sequential Execution
 */

/**
 * Partitions an array of function calls into sequential chunks and parallel chunks.
 *
 * Consecutive read-only tools are grouped into `{ type: 'parallel', calls: [...] }`.
 * Mutating or interactive tools are isolated as `{ type: 'sequential', call: ... }`.
 * Each item in a chunk includes its `originalIndex` to preserve response ordering.
 *
 * @param {Array<{name: string, args: object}>} functionCalls
 * @param {Set<string>} readOnlyTools
 * @returns {Array<{ type: 'parallel', calls: Array<object> } | { type: 'sequential', call: object }>}
 */
export function partitionToolCalls(functionCalls, readOnlyTools) {
  if (!Array.isArray(functionCalls) || functionCalls.length === 0) {
    return [];
  }

  const chunks = [];
  let currentParallelChunk = null;

  for (let i = 0; i < functionCalls.length; i++) {
    const fc = functionCalls[i];
    const isReadOnly = readOnlyTools instanceof Set && readOnlyTools.has(fc.name);

    if (isReadOnly) {
      if (!currentParallelChunk) {
        currentParallelChunk = {
          type: 'parallel',
          calls: [],
        };
        chunks.push(currentParallelChunk);
      }
      currentParallelChunk.calls.push({
        ...fc,
        originalIndex: i,
      });
    } else {
      currentParallelChunk = null;
      chunks.push({
        type: 'sequential',
        call: {
          ...fc,
          originalIndex: i,
        },
      });
    }
  }

  return chunks;
}
