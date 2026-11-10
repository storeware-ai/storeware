import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { css } from './styles';

/**
 * React components for a page the Storeware admin frames.
 *
 * Styled only by the 13 `--sw-*` variables the admin posts, so a panel, a
 * modal or an app's home built from these looks like the admin around it.
 * Put `<AppUiStyles />` once near the root and wrap the page in `<Page>`; the
 * variables come from App Bridge (`AppBridgeProvider` applies them).
 */

export { css, SW_VARIABLES } from './styles';

type Gap = 'tight' | 'base' | 'loose';
type Tone = 'info' | 'ok' | 'warn' | 'bad';

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

/** The stylesheet. Once per page, near the root. */
export function AppUiStyles() {
  return <style data-storeware-app-ui="">{css}</style>;
}

/** The page's ground: the admin's background, text colour and typeface. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={join('sw-page', className)}>{children}</div>;
}

/** A raised panel, with an optional title. */
export function Card({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={join('sw-card', className)}>
      {title ? <h2 className="sw-card-title">{title}</h2> : null}
      {children}
    </section>
  );
}

/** Children one above another. */
export function Stack({ gap = 'base', children }: { gap?: Gap; children: ReactNode }) {
  return <div className={`sw-stack sw-gap-${gap}`}>{children}</div>;
}

/** Children side by side, wrapping when there is no room. */
export function Inline({ gap = 'base', children }: { gap?: Gap; children: ReactNode }) {
  return <div className={`sw-inline sw-gap-${gap}`}>{children}</div>;
}

export function Heading({ level = 2, children }: { level?: 1 | 2 | 3; children: ReactNode }) {
  const Tag = (['h1', 'h2', 'h3'] as const)[level - 1]!;
  return <Tag className={`sw-heading sw-heading-${level}`}>{children}</Tag>;
}

export function Text({
  tone,
  size = 'base',
  mono = false,
  children,
}: {
  tone?: 'muted' | 'ok' | 'warn' | 'bad';
  size?: 'base' | 'small';
  /** For what a machine says: an id, a code, a number to copy. */
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className={join(
        'sw-text',
        tone && `sw-text-${tone}`,
        size === 'small' && 'sw-text-small',
        mono && 'sw-mono',
      )}
    >
      {children}
    </p>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` for the one thing the page is for, `plain` for a quiet link-like action. */
  variant?: 'primary' | 'secondary' | 'plain' | 'danger';
}

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={join('sw-button', variant !== 'secondary' && `sw-button-${variant}`, className)}
      {...props}
    />
  );
}

interface FieldWords {
  label: ReactNode;
  /** A line under the label, saying what goes in. */
  hint?: ReactNode;
  /** What is wrong with what was typed. Marks the control invalid. */
  error?: ReactNode;
}

function Field({ id, words, children }: { id: string; words: FieldWords; children: ReactNode }) {
  return (
    <div className="sw-field">
      <label className="sw-label" htmlFor={id}>
        {words.label}
      </label>
      {words.hint ? (
        <span className="sw-hint" id={`${id}-hint`}>
          {words.hint}
        </span>
      ) : null}
      {children}
      {words.error ? (
        <span className="sw-error" id={`${id}-error`} role="alert">
          {words.error}
        </span>
      ) : null}
    </div>
  );
}

function described(id: string, words: FieldWords): string | undefined {
  const ids = [words.hint ? `${id}-hint` : '', words.error ? `${id}-error` : ''].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export type TextFieldProps = FieldWords & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

/** A labelled text box. */
export function TextField({ label, hint, error, className, ...props }: TextFieldProps) {
  const id = useId();
  const words = { label, hint, error };
  return (
    <Field id={id} words={words}>
      <input
        id={id}
        className={join('sw-input', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, words)}
        {...props}
      />
    </Field>
  );
}

export type SelectProps = FieldWords &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
    options: { value: string; label: string }[];
  };

/** A labelled choice of one. */
export function Select({ label, hint, error, options, className, ...props }: SelectProps) {
  const id = useId();
  const words = { label, hint, error };
  return (
    <Field id={id} words={words}>
      <select
        id={id}
        className={join('sw-select', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, words)}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A box to tick, with its label beside it. */
export function Checkbox({
  label,
  ...props
}: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label className="sw-checkbox">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}

/** A short status, such as Active or Needs review. */
export function Badge({ tone, children }: { tone?: Exclude<Tone, 'info'>; children: ReactNode }) {
  return <span className={join('sw-badge', tone && `sw-badge-${tone}`)}>{children}</span>;
}

/** A message across the page: something to know, something done, something wrong. */
export function Banner({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={join('sw-banner', tone !== 'info' && `sw-banner-${tone}`)}
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      {title ? <p className="sw-banner-title">{title}</p> : null}
      {children}
    </div>
  );
}

/** Something is on its way. Still under reduced motion. */
export function Spinner({ label }: { label: string }) {
  return (
    <span role="status">
      <span className="sw-spinner" aria-hidden="true" />
      <span className="sw-hidden">{label}</span>
    </span>
  );
}

export function Divider() {
  return <hr className="sw-divider" />;
}

/** What a page shows when it has nothing yet, and the way to start. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="sw-empty">
      <p className="sw-empty-title">{title}</p>
      {children ? <p className="sw-text">{children}</p> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}
