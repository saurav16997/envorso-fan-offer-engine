import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Fan Recovery Inbox · Envorso Sports', description: 'Local marketer review for recovery recommendations. No delivery is implemented.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#main">Skip to review inbox</a>{children}</body></html>;
}
