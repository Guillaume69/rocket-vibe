package engine

import (
	"go.mau.fi/whatsmeow/types"
)

// One person is one JID: the phone number when WhatsApp mapped the LID to it.
func (c *connector) canonical(jid types.JID) types.JID {
	jid = jid.ToNonAD()
	if jid.Server == types.HiddenUserServer && c.client != nil && c.client.Store.LIDs != nil {
		if pn, err := c.client.Store.LIDs.GetPNForLID(c.ctx, jid); err == nil && !pn.IsEmpty() {
			return pn.ToNonAD()
		}
	}
	return jid
}

// "me" for my own messages and reactions, else the canonical sender.
func (c *connector) senderKey(fromMe bool, sender types.JID) string {
	if fromMe {
		return "me"
	}
	return c.canonical(sender).String()
}

func (c *connector) setChatName(jid types.JID, name string) {
	if name == "" || c.stopped.Load() {
		return
	}
	_, err := c.vault.db.ExecContext(c.ctx, `INSERT INTO rv_chat_names(jid,name) VALUES(?,?)
 ON CONFLICT(jid) DO UPDATE SET name=excluded.name WHERE rv_chat_names.name != excluded.name`, jid.String(), name)
	if err == nil {
		c.namesDirty.Store(true)
	}
}

// The name WhatsApp would show: the phone's address book first, then the
// name the person chose, the business name, the conversation's name, and
// the number last. Empty when nothing better than the JID is known.
func (c *connector) nameOf(jid types.JID) string {
	var stored string
	_ = c.vault.db.QueryRowContext(c.ctx, `SELECT name FROM rv_chat_names WHERE jid = ?`, jid.String()).Scan(&stored)
	if jid.Server == types.GroupServer {
		return stored
	}
	candidates := []types.JID{jid}
	if c.client != nil && c.client.Store.LIDs != nil {
		if jid.Server == types.DefaultUserServer {
			if lid, err := c.client.Store.LIDs.GetLIDForPN(c.ctx, jid); err == nil && !lid.IsEmpty() {
				candidates = append(candidates, lid)
			}
		} else if jid.Server == types.HiddenUserServer {
			if pn, err := c.client.Store.LIDs.GetPNForLID(c.ctx, jid); err == nil && !pn.IsEmpty() {
				candidates = append(candidates, pn)
			}
		}
	}
	var push, business, redacted string
	for _, candidate := range candidates {
		if c.client == nil {
			break
		}
		contact, err := c.client.Store.Contacts.GetContact(c.ctx, candidate)
		if err != nil || !contact.Found {
			continue
		}
		if contact.FullName != "" {
			return contact.FullName
		}
		if contact.FirstName != "" {
			return contact.FirstName
		}
		if push == "" {
			push = contact.PushName
		}
		if business == "" {
			business = contact.BusinessName
		}
		if redacted == "" {
			redacted = contact.RedactedPhone
		}
	}
	for _, name := range []string{push, business, stored} {
		if name != "" {
			return name
		}
	}
	if jid.Server == types.DefaultUserServer {
		return "+" + jid.User
	}
	return redacted
}

// The names of every chat and sender the cache holds, as one table the
// client swaps in whole.
func (c *connector) emitNames() {
	if c.stopped.Load() {
		return
	}
	rows, err := c.vault.db.QueryContext(c.ctx, `SELECT chat FROM rv_messages UNION SELECT sender FROM rv_messages
 UNION SELECT sender FROM rv_reactions UNION SELECT jid FROM rv_chat_names`)
	if err != nil {
		return
	}
	var jids []string
	for rows.Next() {
		var value string
		if rows.Scan(&value) == nil && value != "me" {
			jids = append(jids, value)
		}
	}
	rows.Close()
	names := make(map[string]string, len(jids))
	for _, value := range jids {
		jid, err := types.ParseJID(value)
		if err != nil {
			continue
		}
		if name := c.nameOf(jid); name != "" {
			names[value] = name
		}
	}
	c.emit(wire{Type: "names", Names: names})
}

// Group names come with the group list, once per connection.
func (c *connector) refreshGroups() {
	groups, err := c.client.GetJoinedGroups(c.ctx)
	if err != nil {
		return
	}
	for _, group := range groups {
		c.setChatName(c.canonical(group.JID), group.Name)
	}
}
