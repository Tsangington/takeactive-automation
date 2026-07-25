type TokenState = {
  idToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
};

let state: TokenState | null = null;

function firebaseKey(): string {
  const key = Deno.env.get("TAKEACTIVE_FIREBASE_KEY");
  if (!key) throw new Error("TAKEACTIVE_FIREBASE_KEY is not set");
  return key;
}

async function passwordLogin(): Promise<TokenState> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: Deno.env.get("TAKEACTIVE_EMAIL"),
        password: Deno.env.get("TAKEACTIVE_PASSWORD"),
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!data.idToken || !data.refreshToken) {
    throw new Error(`Firebase login failed: ${JSON.stringify(data)}`);
  }
  const expiresIn = Number(data.expiresIn ?? 3600);
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

async function refresh(refreshToken: string): Promise<TokenState> {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${firebaseKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    }
  );
  const data = await res.json();
  if (!data.id_token || !data.refresh_token) {
    throw new Error(`Firebase refresh failed: ${JSON.stringify(data)}`);
  }
  const expiresIn = Number(data.expires_in ?? 3600);
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

/** Returns a valid Firebase idToken, refreshing within ~60s of expiry. */
export async function getToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (!state) {
    state = await passwordLogin();
    return state.idToken;
  }

  if (state.expiresAt - now > 60) {
    return state.idToken;
  }

  try {
    state = await refresh(state.refreshToken);
  } catch (err) {
    console.error("Token refresh failed, falling back to password login:", err);
    state = await passwordLogin();
  }
  return state.idToken;
}

export function resetTokenCache(): void {
  state = null;
}
