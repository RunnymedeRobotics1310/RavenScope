import * as Tooltip from "@radix-ui/react-tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AuthGate } from "./components/AuthGate"
import { AcceptInvite } from "./routes/accept-invite"
import { ApiKeysPage } from "./routes/api-keys"
import { CheckEmail } from "./routes/check-email"
import { SessionDetail } from "./routes/session-detail"
import { Sessions } from "./routes/sessions"
import { SignIn } from "./routes/sign-in"
import { WorkspaceSettings } from "./routes/workspace-settings"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
        <BrowserRouter>
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/check-email" element={<CheckEmail />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route element={<AuthGate />}>
              <Route path="/" element={<Sessions />} />
              <Route path="/sessions/:id" element={<SessionDetail />} />
              <Route path="/keys" element={<ApiKeysPage />} />
              <Route path="/workspace/settings" element={<WorkspaceSettings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </Tooltip.Provider>
    </QueryClientProvider>
  )
}
