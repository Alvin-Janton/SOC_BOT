import { ScanLine } from 'lucide-react';

/** Displays the application identity without external images, fonts or branding dependencies. */
export function Brand() {
  return <div className="brand flex items-center gap-2.5"><ScanLine size={21} aria-hidden="true" strokeWidth={1.7} /><span>SOC_BOT</span></div>;
}
