import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createBrowserRouter, Link, RouterProvider, type RouteObject } from "react-router-dom";

import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/primitives";
import { DashboardPage } from "@/pages/DashboardPage";
import { LandingPage } from "@/pages/LandingPage";
import { RunsPage } from "@/pages/RunsPage";
import { SettingsPage } from "@/pages/SettingsPage";

export const routes: RouteObject[] = [
  { path: "/", element: <LandingPage /> },
  {
    path: "/app",
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
  {
    path: "*",
    element: (
      <main className="container py-24 text-center">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <Link to="/" className="text-primary underline">
          Go home
        </Link>
      </main>
    ),
  },
];

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 15_000 } },
  });
}

export function App() {
  const [qc] = useState(makeQueryClient);
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
