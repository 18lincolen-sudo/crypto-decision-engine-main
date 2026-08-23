import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, AlertCircle } from 'lucide-react';
import { securityManager } from '@/utils/securityManager';

interface SecureInputProps {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'email';
  validator?: (value: string) => boolean;
  validationMessage?: string;
  className?: string;
  required?: boolean;
}

const SecureInput: React.FC<SecureInputProps> = ({
  id,
  label,
  value,
  onChange,
  placeholder = '',
  type = 'text',
  validator,
  validationMessage = 'Invalid input format',
  className = '',
  required = false
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const [isValid, setIsValid] = useState(true);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched && value) {
      if (validator) {
        setIsValid(validator(value));
      } else {
        // Default validation - just sanitize
        const sanitized = securityManager.sanitizeInput(value);
        setIsValid(sanitized === value);
      }
    }
  }, [value, validator, touched]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    
    // Sanitize input
    const sanitizedValue = securityManager.sanitizeInput(inputValue);
    
    onChange(sanitizedValue);
    
    if (!touched) {
      setTouched(true);
    }
  };

  const handleBlur = () => {
    setTouched(true);
  };

  const inputType = type === 'password' && showPassword ? 'text' : type;
  const hasError = touched && !isValid && value.length > 0;

  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={id} className="text-sm font-medium">
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </label>
      )}
      
      <div className="relative">
        <Input
          id={id}
          type={inputType}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder={placeholder}
          className={`${className} ${hasError ? 'border-destructive' : ''} ${
            type === 'password' ? 'pr-10' : ''
          }`}
          required={required}
        />
        
        {type === 'password' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 p-0"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        )}
        
        {hasError && (
          <AlertCircle className="absolute right-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-destructive" />
        )}
      </div>
      
      {hasError && validationMessage && (
        <p className="text-sm text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {validationMessage}
        </p>
      )}
    </div>
  );
};

export default SecureInput;