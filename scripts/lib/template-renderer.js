/**
 * Simple template renderer for replacing placeholders with values
 *
 * Supports:
 * - Simple placeholders: {{variable}}
 * - Nested properties: {{object.property.nested}}
 * - No logic/conditionals (values must be pre-computed)
 */

/**
 * Get nested property value from object
 * @param {Object} obj - Source object
 * @param {string} path - Dot-notation path (e.g., "a.b.c")
 * @returns {*} Value at path, or undefined if not found
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, prop) => {
    return current && current[prop] !== undefined ? current[prop] : undefined;
  }, obj);
}

/**
 * Escape HTML entities to prevent XSS in rendered output.
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for HTML insertion
 */
function escapeHtml(str) {
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render template by replacing placeholders with values.
 * FIX L2: Values are HTML-escaped by default to prevent XSS from test output.
 * Use {{{placeholder}}} (triple braces) for raw/pre-escaped HTML.
 *
 * @param {string} template - Template string with {{placeholder}} markers
 * @param {Object} data - Data object with values to substitute
 * @returns {string} Rendered template
 */
function renderTemplate(template, data) {
  // First pass: triple-brace raw HTML (no escaping)
  let result = template.replace(/\{\{\{([^}]+)\}\}\}/g, (match, path) => {
    const value = getNestedValue(data, path.trim());
    return value !== undefined ? String(value) : '';
  });
  // Second pass: double-brace escaped values
  result = result.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getNestedValue(data, path.trim());
    return value !== undefined ? escapeHtml(value) : '';
  });
  return result;
}

module.exports = {
  renderTemplate,
  getNestedValue,
  escapeHtml
};
