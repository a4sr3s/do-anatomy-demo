/**
 * Compact Alexis Reyes Demos lockup (Ar icon + wordmark + tilted "DEMOS" sticker),
 * linking back to the demos hub. Collapses to just the Ar icon below `sm`.
 */
export function Brand() {
  return (
    <a href="https://demos.alexisreyes.com" aria-label="Alexis Reyes · Demos" title="Alexis Reyes · Demos" className="flex shrink-0 items-center gap-2">
      <img src="/brand/alexisreyes-icon-white.svg" alt="Alexis Reyes" className="size-5 sm:hidden" />
      <img src="/brand/alexisreyes-logo-white.svg" alt="Alexis Reyes" className="hidden h-5 w-auto sm:block" />
      <span className="hidden -rotate-6 rounded-md border border-foreground bg-background px-1.5 py-0.5 text-[9px] leading-none font-bold tracking-[0.14em] uppercase shadow-[1.5px_1.5px_0_var(--foreground)] transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] select-none hover:rotate-3 hover:scale-110 sm:inline-block">
        Demos
      </span>
    </a>
  );
}
