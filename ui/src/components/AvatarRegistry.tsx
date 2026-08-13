import { createContext, useContext, type ReactNode } from 'react'

export interface RegisteredAvatar {
  glyph: string
  color: string | null
}

// Avatar is rendered at 14 call sites and every one already passes the member
// id. Resolving the glyph from the id HERE means none of them has to learn
// about avatars, and none of them can forget to pass one.
const AvatarContext = createContext<ReadonlyMap<string, RegisteredAvatar>>(new Map())

export function AvatarRegistryProvider({ value, children }: {
  value: ReadonlyMap<string, RegisteredAvatar>
  children: ReactNode
}) {
  return <AvatarContext.Provider value={value}>{children}</AvatarContext.Provider>
}

// The default is an EMPTY map, not a throw: a component rendered outside the
// provider (every existing component test) falls back to the initial, which is
// exactly the behaviour that shipped before glyphs existed.
export function useRegisteredAvatar(id: string): RegisteredAvatar | null {
  return useContext(AvatarContext).get(id) ?? null
}
