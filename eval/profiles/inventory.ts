import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { dirname } from "node:path";
import { digest, snapshot } from "./files.js";

/** Metadata-only: listCredentials never resolves auth, runs key commands, or refreshes tokens. */
export async function inventory(configPath:string) {
  const config=await loadConfig(configPath);
  const runtime=await ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false});
  const credentials=await runtime.listCredentials();
  return {kind:"offline-configuration-and-catalog",provider_requests:0,transport_resolution:"NOT_RUN",profiles:await Promise.all([...config.executionProfiles.values()].map(async p=>{
    const credential=credentials.find(c=>c.providerId===p.provider),provider=runtime.getProvider(p.provider);
    return {alias:p.alias,permission_profile:p.permissionProfile,provider:p.provider,model:p.model,effort:p.thinkingLevel,
      provider_registered:!!provider,model_registered:!!runtime.getModel(p.provider,p.model),physical_model_registered:!!runtime.getPhysicalModel(p.provider,p.model),
      credential_metadata_present:!!credential,auth_type:credential?.type==="api_key"?"api-key":credential?.type??"unknown",billing_type:credential?.type==="oauth"&&provider?.auth.oauth?.isSubscription?"subscription":"unknown",
      authentication_validity:"NOT_RUN",data_path:"synthetic-fixture-to-selected-provider",
      skills:await Promise.all((p.skills??[]).map(async s=>({identity:s.alias,digest:await snapshot(dirname(s.path)).then(digest,()=>null)}))),
      extensions:(p.extensions??[]).map(e=>({identity:`npm:${e.name}@${e.version}`,digest:null,load_status:"NOT_RUN"})),
    };
  }))};
}
