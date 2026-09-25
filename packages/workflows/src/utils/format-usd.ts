/**
 * USD amount formatter for budget messages.
 *
 * Cents for anything a cent or more ($2.50); two significant digits below that,
 * so a cap of $0.001 reads "$0.001" instead of "$0.00".
 */
export function formatUsd(amount: number): string {
  if (amount === 0 || Math.abs(amount) >= 0.01) return amount.toFixed(2);
  return String(Number(amount.toPrecision(2)));
}
