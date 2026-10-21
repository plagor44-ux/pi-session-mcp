import {
  type AgentSession,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { SdkPiSessionAdapter, type SdkPiSessionAdapterOptions } from "../../src/sdk-pi-adapter.js";

/**
 * Builds the product adapter with the default SDK entry points, wrapped so the public `AgentSession`
 * of each created session reaches `onSession`. Profiles without extensions create through
 * `createSession`; profiles with extensions through `extensionSdk.createRuntime`, whose public
 * `runtime.session` getter is read. No private SDK state is touched.
 */
export function createCapturingAdapter(
  onSession: (session: AgentSession) => void,
  options: Pick<SdkPiSessionAdapterOptions, "modelRuntimeFactory" | "resolveExtension" | "diagnosticSink"> = {},
): SdkPiSessionAdapter {
  return new SdkPiSessionAdapter({
    ...options,
    createSession: async (sessionOptions) => {
      const created = await createAgentSession(sessionOptions);
      onSession(created.session);
      return created;
    },
    extensionSdk: {
      createServices: createAgentSessionServices,
      createSessionFromServices: createAgentSessionFromServices,
      createRuntime: async (factory, runtimeOptions) => {
        const runtime = await createAgentSessionRuntime(factory, runtimeOptions);
        onSession(runtime.session);
        return runtime;
      },
    },
  });
}
