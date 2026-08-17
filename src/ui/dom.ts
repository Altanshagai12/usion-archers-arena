/** Tiny DOM helpers so the UI files stay about layout rather than boilerplate. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A button that works for touch, mouse and keyboard, and is announced properly
 * by screen readers.
 */
export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}
