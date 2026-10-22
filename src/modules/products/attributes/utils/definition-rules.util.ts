import type { AttributeDefinition } from '../types/attribute-definition.types';

/** Cross-field rules shared by create, update (on the merged result) and presets. */
export function definitionIssues(
  d: Pick<AttributeDefinition, 'scope' | 'type' | 'options' | 'variantOption'>,
): string[] {
  const issues: string[] = [];
  if (d.variantOption && d.scope !== 'VARIANT')
    issues.push('Only variant fields can be customer choices');
  const selectable = d.type === 'SELECT' || d.type === 'MULTI_SELECT';
  if (selectable && !d.options.length)
    issues.push('Select fields need options');
  if (!selectable && d.options.length)
    issues.push('Only select fields have options');
  return issues;
}
