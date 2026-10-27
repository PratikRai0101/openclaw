import { describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";
import { prepareTalkClientToolContext } from "./client-tool-authority.js";

const verifiedProfile = "profile-ada";

function elevatedConfig(): OpenClawConfig {
  const allowFrom = { webchat: [verifiedProfile] };
  return {
    tools: { elevated: { enabled: true, allowFrom } },
    agents: { entries: { main: { tools: { elevated: { enabled: true, allowFrom } } } } },
  };
}

function prepareBashElevatedFor(authority: ReturnType<typeof resolveTalkAgentConsultAuthority>) {
  return prepareTalkClientToolContext({
    config: elevatedConfig(),
    agentId: "main",
    authority,
  })?.bashElevated;
}

function prepareBashElevated(client: ReturnType<typeof sharingPolicyClient>) {
  return prepareBashElevatedFor(resolveTalkAgentConsultAuthority(client.connect.scopes, client));
}

describe("Talk client tool authority", () => {
  it("uses the live verified profile for elevated bash", () => {
    const client = sharingPolicyClient({
      user: verifiedProfile,
      scopes: ["operator.read", "operator.write"],
    });

    expect(prepareBashElevated(client)).toMatchObject({
      enabled: true,
      allowed: true,
      defaultLevel: "on",
    });
  });

  it.each([
    [
      "shared gateway-owner attribution",
      () => {
        const client = sharingPolicyClient({
          deviceId: "talk-shared-owner",
          scopes: ["operator.read", "operator.write"],
        });
        client.authenticatedUserProfile = {
          profileId: GATEWAY_OWNER_PROFILE_ID,
          displayName: "Owner",
          hasAvatar: false,
          updatedAt: 1,
        };
        return client;
      },
    ],
    [
      "a synthetic caller",
      () => {
        const client = sharingPolicyClient({
          user: verifiedProfile,
          scopes: ["operator.read", "operator.write"],
        });
        client.internal = { syntheticClient: true };
        return client;
      },
    ],
  ] as const)("keeps %s denied by exact-profile elevated bash", (_name, create) => {
    expect(prepareBashElevated(create())).toMatchObject({ enabled: true, allowed: false });
  });

  it("rechecks the live reply caller before elevated bash after revocation", () => {
    const lifetime = new AbortController();
    const client = sharingPolicyClient({
      user: verifiedProfile,
      scopes: ["operator.read", "operator.write"],
    });
    client.connectionSignal = lifetime.signal;
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);

    expect(prepareBashElevatedFor(authority)).toMatchObject({ enabled: true, allowed: true });
    lifetime.abort();
    expect(prepareBashElevatedFor(authority)).toMatchObject({ enabled: true, allowed: false });
  });
});
