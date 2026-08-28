/**
 * Content Sanitizer - Prevents XSS and ensures safe content rendering
 */

interface SanitizeOptions {
  allowedTags?: string[];
  allowedAttributes?: { [key: string]: string[] };
  stripAll?: boolean;
}

class ContentSanitizer {
  private readonly DEFAULT_ALLOWED_TAGS = [
    'b', 'i', 'em', 'strong', 'span', 'div', 'p', 'br'
  ];

  private readonly DEFAULT_ALLOWED_ATTRIBUTES = {
    'span': ['class'],
    'div': ['class'],
    'p': ['class']
  };

  /**
   * Sanitize HTML content to prevent XSS attacks
   */
  sanitizeHTML(content: string, options: SanitizeOptions = {}): string {
    if (!content || typeof content !== 'string') {
      return '';
    }

    const {
      allowedTags = this.DEFAULT_ALLOWED_TAGS,
      allowedAttributes = this.DEFAULT_ALLOWED_ATTRIBUTES,
      stripAll = false
    } = options;

    if (stripAll) {
      return this.stripAllHTML(content);
    }

    // Remove script tags and their content
    content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove javascript: protocols
    content = content.replace(/javascript:/gi, '');
    
    // Remove on* event handlers
    content = content.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
    content = content.replace(/\s*on\w+\s*=\s*[^>\s]+/gi, '');
    
    // Remove dangerous protocols
    content = content.replace(/(data|vbscript|mhtml):/gi, '');
    
    // Simple tag whitelist approach
    if (allowedTags.length > 0) {
      const tagPattern = new RegExp(`<(?!/?(?:${allowedTags.join('|')})\\b)[^>]+>`, 'gi');
      content = content.replace(tagPattern, '');
    }

    // Clean attributes
    Object.keys(allowedAttributes).forEach(tag => {
      const allowedAttrs = allowedAttributes[tag];
      const attrPattern = new RegExp(`(<${tag}[^>]*?)\\s+(\\w+)=(["'])[^"']*\\3`, 'gi');
      
      content = content.replace(attrPattern, (match, openTag, attrName, quote) => {
        if (allowedAttrs.includes(attrName.toLowerCase())) {
          return match;
        }
        return openTag;
      });
    });

    return content;
  }

  /**
   * Strip all HTML tags from content
   */
  stripAllHTML(content: string): string {
    if (!content || typeof content !== 'string') {
      return '';
    }
    
    return content
      .replace(/<[^>]*>/g, '') // Remove all HTML tags
      .replace(/&[a-zA-Z0-9#]+;/g, ' ') // Remove HTML entities
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim();
  }

  /**
   * Sanitize text content for safe display
   */
  sanitizeText(text: string): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    return text
      .replace(/[<>]/g, '') // Remove angle brackets
      .replace(/javascript:/gi, '') // Remove javascript protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .trim();
  }

  /**
   * Sanitize CSS class names
   */
  sanitizeClassName(className: string): string {
    if (!className || typeof className !== 'string') {
      return '';
    }

    return className
      .replace(/[^a-zA-Z0-9\-_\s]/g, '') // Only allow alphanumeric, hyphens, underscores, spaces
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim();
  }

  /**
   * Sanitize URLs to prevent XSS
   */
  sanitizeURL(url: string): string {
    if (!url || typeof url !== 'string') {
      return '';
    }

    // Remove dangerous protocols
    if (/^(javascript|data|vbscript|mhtml):/i.test(url)) {
      return '';
    }

    // Only allow http, https, and relative URLs
    if (!/^(https?:\/\/|\/|\.\/|#)/.test(url)) {
      return '';
    }

    return url.trim();
  }

  /**
   * Create safe CSS-in-JS styles instead of dangerouslySetInnerHTML
   */
  createSafeStyles(styleConfig: Record<string, unknown>): React.CSSProperties {
    const safeStyles: React.CSSProperties = {};
    
    if (!styleConfig || typeof styleConfig !== 'object') {
      return safeStyles;
    }

    // Only allow specific safe CSS properties
    const allowedProperties = [
      'color', 'backgroundColor', 'fontSize', 'fontWeight', 'textAlign',
      'padding', 'margin', 'border', 'borderRadius', 'width', 'height',
      'display', 'position', 'top', 'left', 'right', 'bottom',
      'transform', 'opacity', 'zIndex'
    ];

    Object.keys(styleConfig).forEach(property => {
      if (allowedProperties.includes(property)) {
        const value = styleConfig[property];
        
        // Validate CSS values
        if (typeof value === 'string' && this.isValidCSSValue(value)) {
          (safeStyles as Record<string, string | number>)[property] = value;
        } else if (typeof value === 'number') {
          (safeStyles as Record<string, string | number>)[property] = value;
        }
      }
    });

    return safeStyles;
  }

  /**
   * Validate CSS values to prevent injection
   */
  private isValidCSSValue(value: string): boolean {
    // Reject values containing dangerous characters or functions
    const dangerousPatterns = [
      /javascript:/i,
      /expression\s*\(/i,
      /url\s*\(\s*["']?\s*javascript:/i,
      /@import/i,
      /<.*>/,
      /&[a-zA-Z]+;/
    ];

    return !dangerousPatterns.some(pattern => pattern.test(value));
  }

  /**
   * Sanitize object for safe JSON serialization
   */
  sanitizeObject(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      return this.sanitizeText(obj);
    }

    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    if (typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      Object.keys(obj).forEach(key => {
        const sanitizedKey = this.sanitizeText(key);
        if (sanitizedKey) {
          sanitized[sanitizedKey] = this.sanitizeObject((obj as Record<string, unknown>)[key]);
        }
      });
      return sanitized;
    }

    return obj;
  }
}

export const contentSanitizer = new ContentSanitizer();

// Helper function for safe HTML rendering
export const createSafeHTML = (content: string, className?: string) => {
  const safeContent = contentSanitizer.sanitizeHTML(content);
  const safeClassName = contentSanitizer.sanitizeClassName(className || '');
  
  return {
    content: safeContent,
    className: safeClassName,
    dangerouslySetInnerHTML: { __html: safeContent }
  };
};