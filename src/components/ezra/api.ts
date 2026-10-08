export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(payload.error || `Request failed with ${response.status}.`, response.status);
  }
  return payload;
}

export function post<T>(url: string, body: unknown) {
  return api<T>(url, { method: "POST", body: JSON.stringify(body) });
}

/** Deliberate passkey ceremony bound to the server's exact canonical action. */
export async function confirmGrantReview(reviewHash:string):Promise<string>{
  type Options=Omit<PublicKeyCredentialRequestOptions,"challenge"|"allowCredentials">&{challenge:string;allowCredentials?:Array<Omit<PublicKeyCredentialDescriptor,"id">&{id:string}>};
  const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),char=>char.charCodeAt(0));
  const encode=(value:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const start=await post<{challengeId:string;options:Options}>("/api/auth/step-up/options",{action:"manage_agent_grants",reviewHash});
  const credential=await navigator.credentials.get({publicKey:{...start.options,challenge:decode(start.options.challenge),allowCredentials:start.options.allowCredentials?.map(c=>({...c,id:decode(c.id)}))}}) as PublicKeyCredential|null;
  if(!credential)throw new Error("Passkey confirmation cancelled.");
  const response=credential.response as AuthenticatorAssertionResponse;
  const verified=await post<{receiptId:string}>("/api/auth/step-up/verify",{challengeId:start.challengeId,action:"manage_agent_grants",reviewHash,response:{id:credential.id,rawId:encode(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:encode(response.clientDataJSON),authenticatorData:encode(response.authenticatorData),signature:encode(response.signature),userHandle:response.userHandle?encode(response.userHandle):undefined}}});
  return verified.receiptId;
}