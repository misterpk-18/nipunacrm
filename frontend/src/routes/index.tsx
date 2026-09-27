import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/auth/auth";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { profile } = useAuth();
  return <Navigate to={profile?.home_route ?? "/login"} replace />;
}
