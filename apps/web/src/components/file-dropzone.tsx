'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { FileCheck2, Upload, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A single-file dropzone.
 *
 * Hand-built on the native HTML5 drag-and-drop API rather than pulling in a dependency. What
 * that buys, beyond one fewer package: the hidden `<input type="file">` remains the real
 * control, so keyboard and screen-reader users get the platform file picker for free, which
 * wrapper libraries routinely break.
 *
 * Validation happens here as well as on the server. Client-side checks are a courtesy — telling
 * someone their 40MB scan is too large before they wait for an upload — and are never trusted:
 * the API re-validates size, type and readability.
 */

const MAX_BYTES = 10 * 1024 * 1024; // SOP-001 step 6.

interface FileDropzoneProps {
  readonly label: string;
  readonly hint: string;
  readonly accept: readonly string[];
  readonly file: File | null;
  readonly onChange: (file: File | null) => void;
  readonly disabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
}

export function FileDropzone({
  label,
  hint,
  accept,
  file,
  onChange,
  disabled = false,
}: FileDropzoneProps): React.ReactElement {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = useCallback(
    (candidate: File): string | null => {
      if (candidate.size === 0) {
        return 'That file is empty.';
      }
      if (candidate.size > MAX_BYTES) {
        return `That file is ${formatBytes(candidate.size)}. The limit is 10 MB.`;
      }
      // Match on extension: browsers report inconsistent MIME types, and Windows frequently
      // sends application/octet-stream for a perfectly valid PDF.
      if (!accept.includes(extensionOf(candidate.name))) {
        return `Unsupported file type. Accepted: ${accept.join(', ')}.`;
      }
      return null;
    },
    [accept],
  );

  const accept_ = useCallback(
    (candidate: File | undefined) => {
      if (candidate === undefined) {
        return;
      }
      const problem = validate(candidate);
      if (problem !== null) {
        setError(problem);
        onChange(null);
        return;
      }
      setError(null);
      onChange(candidate);
    },
    [onChange, validate],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) {
        return;
      }
      accept_(event.dataTransfer.files[0]);
    },
    [accept_, disabled],
  );

  const clear = useCallback(() => {
    setError(null);
    onChange(null);
    if (inputRef.current !== null) {
      inputRef.current.value = '';
    }
  }, [onChange]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-ink)]">
        {label}
      </label>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          'relative rounded-[var(--radius-card)] border-2 border-dashed px-4 py-6 text-center transition-colors',
          isDragging
            ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
            : file !== null
              ? 'border-[var(--color-positive)]/50 bg-[var(--color-positive-soft)]'
              : error !== null
                ? 'border-[var(--color-negative)]/50 bg-[var(--color-negative-soft)]'
                : 'border-[var(--color-line-strong)] bg-[var(--color-surface)]',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept.join(',')}
          disabled={disabled}
          onChange={(event) => accept_(event.target.files?.[0])}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          aria-describedby={`${inputId}-hint`}
        />

        {file !== null ? (
          <div className="pointer-events-none flex flex-col items-center gap-1">
            <FileCheck2 size={26} className="text-[var(--color-positive)]" aria-hidden />
            <p className="max-w-full truncate text-sm font-medium text-[var(--color-ink)]">
              {file.name}
            </p>
            <p className="numeric text-xs text-[var(--color-ink-subtle)]">
              {formatBytes(file.size)}
            </p>
            <button
              type="button"
              onClick={clear}
              disabled={disabled}
              className="pointer-events-auto relative z-10 mt-1 inline-flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1 text-xs font-medium text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]"
            >
              <X size={12} aria-hidden />
              Remove
            </button>
          </div>
        ) : (
          <div className="pointer-events-none flex flex-col items-center gap-1">
            <Upload size={26} className="text-[var(--color-ink-subtle)]" aria-hidden />
            <p className="text-sm font-medium text-[var(--color-ink)]">
              Drop a file or click to browse
            </p>
            <p id={`${inputId}-hint`} className="text-xs text-[var(--color-ink-subtle)]">
              {hint}
            </p>
          </div>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-xs font-medium text-[var(--color-negative)]">
          {error}
        </p>
      )}
    </div>
  );
}
