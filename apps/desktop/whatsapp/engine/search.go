package engine

import (
	"context"
	"sort"
	"strings"
	"time"
	"unicode"

	"go.mau.fi/whatsmeow/types"
)

// Results of a search for "new conversation".
const maxFound = 30

type person struct {
	JID  string `json:"jid"`
	Name string `json:"name"`
}

// The digits of a phone number as typed (+33 6 12 34 56 78), when it is one.
func phoneDigits(query string) (string, bool) {
	var digits strings.Builder
	for _, r := range query {
		switch {
		case unicode.IsDigit(r):
			digits.WriteRune(r)
		case r == '+' || r == ' ' || r == '-' || r == '.' || r == '(' || r == ')':
		default:
			return "", false
		}
	}
	n := digits.Len()
	return digits.String(), n >= 6 && n <= 15
}

// People and groups matching `query`: the phone's contacts by name or number,
// the groups by subject, and a typed number WhatsApp knows.
func (c *connector) search(cmd command) {
	query := strings.ToLower(strings.TrimSpace(cmd.Text))
	found := []person{}
	seen := map[string]bool{}
	add := func(jid types.JID, name string) {
		key := jid.String()
		if seen[key] || len(found) >= maxFound {
			return
		}
		seen[key] = true
		found = append(found, person{JID: key, Name: name})
	}
	if digits, ok := phoneDigits(query); ok && c.ready() {
		ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
		answers, err := c.client.IsOnWhatsApp(ctx, []string{"+" + digits})
		cancel()
		if err == nil && len(answers) == 1 && answers[0].IsIn {
			jid := c.canonical(answers[0].JID)
			name := c.nameOf(jid)
			if name == "" {
				name = "+" + digits
			}
			add(jid, name)
		}
	}
	if query != "" && c.client != nil {
		contacts, err := c.client.Store.Contacts.GetAllContacts(c.ctx)
		if err == nil {
			var matches []person
			for jid, contact := range contacts {
				canonical := c.canonical(jid)
				if canonical.Server != types.DefaultUserServer {
					continue
				}
				name := c.nameOf(canonical)
				haystack := strings.ToLower(strings.Join([]string{contact.FullName, contact.FirstName,
					contact.PushName, contact.BusinessName, name, canonical.User}, " "))
				if strings.Contains(haystack, query) {
					matches = append(matches, person{JID: canonical.String(), Name: name})
				}
			}
			rows, err := c.vault.db.QueryContext(c.ctx, `SELECT jid,name FROM rv_chat_names WHERE jid LIKE '%@g.us'`)
			if err == nil {
				for rows.Next() {
					var p person
					if rows.Scan(&p.JID, &p.Name) == nil && strings.Contains(strings.ToLower(p.Name), query) {
						matches = append(matches, p)
					}
				}
				rows.Close()
			}
			sort.Slice(matches, func(i, j int) bool { return strings.ToLower(matches[i].Name) < strings.ToLower(matches[j].Name) })
			for _, p := range matches {
				if jid, err := validChat(p.JID); err == nil {
					add(jid, p.Name)
				}
			}
		}
	}
	c.emit(wire{Type: "found", ID: cmd.ID, People: found})
}
