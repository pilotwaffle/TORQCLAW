import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });

export const metadata: Metadata = { title: 'TORQCLAW // ORCHESTRATOR' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      {/* suppressHydrationWarning: browser extensions (e.g. screenshot tools)
          mutate <body> classes before React hydrates; that mismatch is benign. */}
      <body className="bg-bg text-ink antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
