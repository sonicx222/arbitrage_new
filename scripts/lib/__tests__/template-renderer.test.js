/**
 * Unit tests for template-renderer.js
 */

const { renderTemplate, getNestedValue } = require('../template-renderer');

describe('template-renderer', () => {
  describe('getNestedValue', () => {
    it('should get simple property', () => {
      const obj = { name: 'John' };
      expect(getNestedValue(obj, 'name')).toBe('John');
    });

    it('should get nested property', () => {
      const obj = { user: { name: 'John', age: 30 } };
      expect(getNestedValue(obj, 'user.name')).toBe('John');
      expect(getNestedValue(obj, 'user.age')).toBe(30);
    });

    it('should get deeply nested property', () => {
      const obj = { a: { b: { c: { d: 'value' } } } };
      expect(getNestedValue(obj, 'a.b.c.d')).toBe('value');
    });

    it('should return undefined for missing property', () => {
      const obj = { name: 'John' };
      expect(getNestedValue(obj, 'missing')).toBeUndefined();
    });

    it('should return undefined for missing nested property', () => {
      const obj = { user: { name: 'John' } };
      expect(getNestedValue(obj, 'user.missing.value')).toBeUndefined();
    });

    it('should handle null/undefined gracefully', () => {
      expect(getNestedValue(null, 'any')).toBeUndefined();
      expect(getNestedValue(undefined, 'any')).toBeUndefined();
    });
  });

  describe('renderTemplate', () => {
    it('should replace simple placeholder', () => {
      const template = 'Hello {{name}}!';
      const data = { name: 'World' };
      expect(renderTemplate(template, data)).toBe('Hello World!');
    });

    it('should replace multiple placeholders', () => {
      const template = '{{greeting}} {{name}}!';
      const data = { greeting: 'Hello', name: 'World' };
      expect(renderTemplate(template, data)).toBe('Hello World!');
    });

    it('should replace nested property placeholders', () => {
      const template = 'User: {{user.name}}, Age: {{user.age}}';
      const data = { user: { name: 'John', age: 30 } };
      expect(renderTemplate(template, data)).toBe('User: John, Age: 30');
    });

    it('should handle deeply nested properties', () => {
      const template = 'Value: {{a.b.c.d}}';
      const data = { a: { b: { c: { d: 'deep' } } } };
      expect(renderTemplate(template, data)).toBe('Value: deep');
    });

    it('should replace missing placeholders with empty string', () => {
      const template = 'Hello {{name}}, {{missing}}!';
      const data = { name: 'World' };
      expect(renderTemplate(template, data)).toBe('Hello World, !');
    });

    it('should handle placeholders with spaces', () => {
      const template = 'Hello {{ name }}!';
      const data = { name: 'World' };
      expect(renderTemplate(template, data)).toBe('Hello World!');
    });

    it('should handle numeric values', () => {
      const template = 'Count: {{count}}';
      const data = { count: 42 };
      expect(renderTemplate(template, data)).toBe('Count: 42');
    });

    it('should handle boolean values', () => {
      const template = 'Active: {{active}}, Disabled: {{disabled}}';
      const data = { active: true, disabled: false };
      expect(renderTemplate(template, data)).toBe('Active: true, Disabled: false');
    });

    it('should handle HTML content', () => {
      const template = '<div>{{content}}</div>';
      const data = { content: '<span>Hello</span>' };
      expect(renderTemplate(template, data)).toBe('<div><span>Hello</span></div>');
    });

    it('should handle empty template', () => {
      expect(renderTemplate('', {})).toBe('');
    });

    it('should handle template with no placeholders', () => {
      const template = 'No placeholders here';
      expect(renderTemplate(template, {})).toBe('No placeholders here');
    });

    it('should handle complex real-world scenario', () => {
      const template = `
        <h1>{{title}}</h1>
        <p>Author: {{author.name}} ({{author.email}})</p>
        <p>Date: {{date}}</p>
        <p>Score: {{metrics.score}} / {{metrics.total}}</p>
      `;
      const data = {
        title: 'Test Report',
        author: { name: 'John Doe', email: 'john@example.com' },
        date: '2024-01-01',
        metrics: { score: 95, total: 100 }
      };
      const result = renderTemplate(template, data);
      expect(result).toContain('Test Report');
      expect(result).toContain('John Doe');
      expect(result).toContain('john@example.com');
      expect(result).toContain('2024-01-01');
      expect(result).toContain('95');
      expect(result).toContain('100');
    });
  });
});
