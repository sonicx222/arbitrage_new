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
 * Render template by replacing placeholders with values
 * @param {string} template - Template string with {{placeholder}} markers
 * @param {Object} data - Data object with values to substitute
 * @returns {string} Rendered template
 */
function renderTemplate(template, data) {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getNestedValue(data, path.trim());
    return value !== undefined ? value : '';
  });
}

module.exports = {
  renderTemplate,
  getNestedValue
};
