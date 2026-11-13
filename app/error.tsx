'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="loading-page" role="alert"><h1>The local inbox could not open</h1><p>Check that the database path is writable and the app is running from the project directory.</p><button onClick={reset}>Try again</button></main>;
}
