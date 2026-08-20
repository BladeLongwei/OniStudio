import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  filterIanaTimeZones,
  ianaTimeZoneSelectOptions,
} from '../utils/ianaTimeZones';
import styles from './IanaTimeZoneCombobox.module.css';

export type IanaTimeZoneComboboxProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Shown as first list option that clears the value. Omit to disallow empty. */
  emptyLabel?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  id?: string;
  'aria-label'?: string;
};

export function IanaTimeZoneCombobox({
  value,
  onChange,
  disabled = false,
  emptyLabel,
  placeholder = 'Search time zones...',
  className,
  inputClassName,
  id: idProp,
  'aria-label': ariaLabel = 'Time zone',
}: IanaTimeZoneComboboxProps) {
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const inputId = idProp || `${reactId}-input`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const options = useMemo(() => ianaTimeZoneSelectOptions(value), [value]);
  const filtered = useMemo(
    () => filterIanaTimeZones(query, options),
    [query, options],
  );

  const items = useMemo(() => {
    const rows: { value: string; label: string }[] = [];
    if (emptyLabel != null) {
      rows.push({ value: '', label: emptyLabel });
    }
    for (const tz of filtered) {
      rows.push({ value: tz, label: tz });
    }
    return rows;
  }, [emptyLabel, filtered]);

  useEffect(() => {
    if (!open) return;
    setHighlight(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${listboxId}-opt-${highlight}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight, listboxId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const selectValue = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  };

  const displayValue = open ? query : value;

  return (
    <div
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
    >
      <div className={styles.inputWrap}>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && items[highlight] ? `${listboxId}-opt-${highlight}` : undefined
          }
          className={[styles.input, inputClassName].filter(Boolean).join(' ')}
          value={displayValue}
          placeholder={value || placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => {
            if (disabled) return;
            setOpen(true);
            setQuery('');
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!open) {
                setOpen(true);
                return;
              }
              setHighlight((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              if (open && items[highlight]) {
                e.preventDefault();
                selectValue(items[highlight].value);
              }
            } else if (e.key === 'Escape') {
              if (open) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                setQuery('');
              }
            }
          }}
        />
        <button
          type="button"
          className={styles.chevronBtn}
          tabIndex={-1}
          disabled={disabled}
          aria-label={open ? 'Close time zone list' : 'Open time zone list'}
          onClick={() => {
            if (disabled) return;
            if (open) {
              setOpen(false);
              setQuery('');
            } else {
              setOpen(true);
              setQuery('');
              inputRef.current?.focus();
            }
          }}
        >
          <ChevronDown size={16} aria-hidden />
        </button>
      </div>
      {open && (
        <ul id={listboxId} role="listbox" className={styles.listbox}>
          {items.length === 0 ? (
            <li className={styles.empty} role="presentation">
              No matching time zones
            </li>
          ) : (
            items.map((item, index) => {
              const selected = item.value === value;
              const active = index === highlight;
              return (
                <li
                  key={item.value || '__empty__'}
                  id={`${listboxId}-opt-${index}`}
                  role="option"
                  aria-selected={selected}
                  className={[
                    styles.option,
                    active ? styles.optionActive : '',
                    selected ? styles.optionSelected : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectValue(item.value);
                  }}
                >
                  {item.label}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
