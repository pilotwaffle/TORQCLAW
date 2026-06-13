import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'TORQCLAW // ORCHESTRATOR' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. screenshot tools)
          mutate <body> classes before React hydrates; that mismatch is benign. */}
      <body className="bg-[#0a0a0a] antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
