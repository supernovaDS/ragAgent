import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { ClerkProvider } from '@clerk/clerk-react'
import { dark } from '@clerk/themes'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY. Add it to your .env file.")
}

// Fix #14: match Clerk theme to stored user preference or system default
const savedTheme = localStorage.getItem('theme')
const prefersDark = savedTheme 
  ? savedTheme === 'dark' 
  : window.matchMedia('(prefers-color-scheme: dark)').matches
const clerkTheme = prefersDark ? dark : undefined

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ClerkProvider 
      publishableKey={PUBLISHABLE_KEY} 
      afterSignOutUrl="/"
      appearance={{ baseTheme: clerkTheme }}
    >
      <App />
    </ClerkProvider>
  </React.StrictMode>
)

