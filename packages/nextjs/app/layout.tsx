import type { Metadata } from 'next';
import './style.css';
export const metadata: Metadata = {
  title: 'DeliverProof · Verify before approval',
  description: 'A testnet delivery agreement with verifiable file bytes and separate approval and withdrawal.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
