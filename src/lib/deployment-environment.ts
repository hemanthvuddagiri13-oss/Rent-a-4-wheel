export type DeploymentEnvironment = "development" | "test" | "preview" | "staging" | "production";
export type Environment = Readonly<Record<string, string | undefined>>;

// NODE_ENV describes the Next build, not the deployment's trust boundary.
export function deploymentEnvironment(env: Environment = process.env): DeploymentEnvironment {
  const value = env.APP_ENV;
  if (value === "development" || value === "test" || value === "preview" || value === "staging" || value === "production") return value;
  return env.NODE_ENV === "test" ? "test" : env.NODE_ENV === "development" ? "development" : "production";
}
export function localDevelopment(env: Environment = process.env): boolean {
  return ["development", "test"].includes(deploymentEnvironment(env)) && env.NODE_ENV !== "production" && !env.VERCEL_ENV;
}
