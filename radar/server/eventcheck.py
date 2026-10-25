# -*- coding: utf-8 -*-
"""Conservative sanity check: does the model's event_type contradict a CLEAR event keyword in the record's old description?
If it does, the event label must not be shown (use the neutral 'Project update')."""
import re

KW = [("Acquisition/Sale", r"\b(acquir|acquisition|buys?|bought|purchas|sells?|sold|takes? over)"),
      ("Construction start", r"\b(break|broke|breaks|broken) ground|construction (start|begin|begins|began|has begun)|begins? construction|starts? construction|under construction"),
      ("Permit/Approval", r"\b(approv|permit|licen[cs]e|consent|rezon|zoning|planning permission|authori[sz])"),
      ("Financing", r"\b(financ|loan|funding|raises?|raised|equity|debt|bond)"),
      ("Tender", r"\b(tender|rfp|bids?|request for proposal)"),
      ("Offtake/Supply agreement", r"\b(ppa|power purchase|offtake|supply (deal|agreement)|leases?)"),
      ("Award", r"\b(awarded|wins?|won|contract|selected)"),
      ("Delivery/Commissioning", r"\b(commission|energi[sz]ed|opens?|opened|inaugurat|goes live|operational|delivered)"),
      ("FID", r"\b(fid|final investment decision)")]
_RX = [(k, re.compile(p, re.I)) for k, p in KW]


def old_text_events(text):
    return [k for k, rx in _RX if rx.search(text or "")]


def event_conflicts(old_description, event_type):
    """True when the old text names at least one clear event and the model's non-'Other' type is none of them."""
    if not event_type or event_type == "Other":
        return False
    hits = old_text_events(old_description)
    return bool(hits) and event_type not in hits
