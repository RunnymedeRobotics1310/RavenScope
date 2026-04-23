import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AuthGate } from "./components/AuthGate"
import { ApiKeysPage } from "./routes/api-keys"
import { CheckEmail } from "./routes/check-email"
import { SessionDetail } from "./routes/session-detail"
import { Sessions } from "./routes/sessions"
import { SignIn } from "./routes/sign-in"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/check-email" element={<CheckEmail />} />
          <Route element={<AuthGate />}>
            <Route path="/" element={<Sessions />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/keys" element={<ApiKeysPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
