import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Count On Local',
  description: 'Start a business where you live.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
