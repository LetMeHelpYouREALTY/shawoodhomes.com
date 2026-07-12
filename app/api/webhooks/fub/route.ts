/**
 * Follow Up Boss Webhook Handler
 * 
 * Handles real-time events from FUB:
 * - peopleCreated
 * - peopleUpdated
 * - peopleDeleted
 * - peopleStageUpdated
 * - peopleTagsCreated
 * 
 * Integrates with:
 * - Claude AI for lead qualification
 * - RealScout for property matching
 * - Email notifications
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { FollowUpBossClient } from '@/lib/fub/client';
import { ClaudeClient } from '@/lib/claude/client';
import { propertySearchTemplate } from '@/lib/claude/prompt-templates';

export async function POST(request: NextRequest) {
  try {
    // Read the raw body first — signature verification requires the exact
    // bytes FUB sent, before any JSON re-serialization.
    const rawBody = await request.text();
    const signature = request.headers.get('FUB-Signature');
    const systemKey = process.env.FUB_SYSTEM_KEY || process.env.FUB_WEBHOOK_SECRET;

    if (systemKey) {
      if (!verifySignature(rawBody, signature, systemKey)) {
        console.error('[FUB Webhook] Rejected request with invalid or missing signature');
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    } else {
      // No system key configured — we can't verify authenticity. Fail closed
      // in production so the endpoint can't be abused by unauthenticated callers.
      console.warn(
        '[FUB Webhook] FUB_SYSTEM_KEY is not configured — signature verification is disabled.'
      );
      if (process.env.NODE_ENV === 'production') {
        return NextResponse.json(
          { error: 'Webhook is not configured for signature verification' },
          { status: 503 }
        );
      }
    }

    const body = JSON.parse(rawBody);
    const { event, data } = body;

    console.log(`[FUB Webhook] Received event: ${event}`);

    // Route to appropriate handler
    switch (event) {
      case 'peopleCreated':
        await handlePersonCreated(data);
        break;

      case 'peopleUpdated':
        await handlePersonUpdated(data);
        break;

      case 'peopleStageUpdated':
        await handleStageUpdated(data);
        break;

      case 'peopleTagsCreated':
        await handleTagsCreated(data);
        break;

      case 'peopleDeleted':
        await handlePersonDeleted(data);
        break;

      default:
        console.log(`[FUB Webhook] Unhandled event: ${event}`);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[FUB Webhook] Error:', error);
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}

/**
 * Handle new person (lead) created
 */
async function handlePersonCreated(data: any) {
  console.log(`[FUB] New person created: ${data.name || data.id}`);

  const fub = new FollowUpBossClient({
    apiKey: process.env.FUB_API_KEY || '',
  });

  try {
    // Get full person details
    const person = await fub.getPerson(data.id);

    // Auto-qualify lead with Claude AI
    if (process.env.ANTHROPIC_API_KEY) {
      await qualifyLeadWithAI(person, fub);
    }

    // Add welcome tag
    await fub.addTag(person.id, 'website-lead');

    // Create event in FUB
    await fub.createEvent({
      source: 'website',
      type: 'Note',
      message: 'New lead captured from website',
      personId: person.id,
      data: {
        source: person.source || 'website',
        stage: person.stage || 'new',
      },
    });

    // Send notification (implement your notification service)
    // await sendSlackNotification(`New lead: ${person.name}`);
    // await sendEmailNotification(person);

  } catch (error) {
    console.error('[FUB] Error processing new person:', error);
  }
}

/**
 * Handle person updated
 */
async function handlePersonUpdated(data: any) {
  console.log(`[FUB] Person updated: ${data.name || data.id}`);

  // Track what changed
  const changes = data.changes || {};
  
  // If email or phone changed, check for duplicates
  if (changes.emails || changes.phones) {
    await checkForDuplicates(data.id);
  }

  // If stage changed to "Active Buyer", trigger property search
  if (changes.stage === 'Active Buyer') {
    await triggerPropertySearch(data.id);
  }
}

/**
 * Handle stage updated
 */
async function handleStageUpdated(data: any) {
  console.log(`[FUB] Stage updated for ${data.name || data.id}: ${data.stage}`);

  const fub = new FollowUpBossClient({
    apiKey: process.env.FUB_API_KEY || '',
  });

  try {
    // Add stage-specific tags and actions
    switch (data.stage) {
      case 'Active Buyer':
        await fub.addTag(data.id, 'active-buyer');
        await triggerPropertySearch(data.id);
        break;

      case 'Active Seller':
        await fub.addTag(data.id, 'active-seller');
        // Trigger home valuation workflow
        break;

      case 'Under Contract':
        await fub.addTag(data.id, 'under-contract');
        // Trigger pre-closing checklist
        break;

      case 'Closed':
        await fub.addTag(data.id, 'closed');
        // Trigger post-closing follow-up
        break;
    }

    // Log event
    await fub.createEvent({
      source: 'automation',
      type: 'Stage Change',
      message: `Stage updated to: ${data.stage}`,
      personId: data.id,
    });

  } catch (error) {
    console.error('[FUB] Error handling stage update:', error);
  }
}

/**
 * Handle tags created
 */
async function handleTagsCreated(data: any) {
  console.log(`[FUB] Tags added to ${data.name || data.id}: ${data.tags?.join(', ')}`);

  const fub = new FollowUpBossClient({
    apiKey: process.env.FUB_API_KEY || '',
  });

  // Trigger actions based on specific tags
  for (const tag of data.tags || []) {
    switch (tag.toLowerCase()) {
      case 'summerlin':
      case 'henderson':
      case 'green valley':
        // Search for properties in that area
        await triggerPropertySearch(data.id, tag);
        break;

      case 'luxury':
        await fub.createEvent({
          source: 'automation',
          type: 'Note',
          message: `Tagged as luxury buyer - recommend Ridges, Southern Highlands`,
          personId: data.id,
        });
        break;

      case '55+':
        await fub.createEvent({
          source: 'automation',
          type: 'Note',
          message: `Tagged as 55+ - recommend Sun City Summerlin, Sun City Anthem`,
          personId: data.id,
        });
        break;
    }
  }
}

/**
 * Handle person deleted
 */
async function handlePersonDeleted(data: any) {
  console.log(`[FUB] Person deleted: ${data.id}`);
  
  // Clean up any external integrations
  // await removeFromRealScout(data.id);
  // await removeFromMailingLists(data.id);
}

/**
 * Qualify lead with Claude AI
 */
async function qualifyLeadWithAI(person: any, fub: FollowUpBossClient) {
  try {
    const claude = new ClaudeClient({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });

    // Build context about the lead
    const context = `
New lead information:
- Name: ${person.name || 'Unknown'}
- Source: ${person.source || 'Unknown'}
- Stage: ${person.stage || 'New'}
- Tags: ${person.tags?.join(', ') || 'None'}
- Custom fields: ${JSON.stringify(person.customFields || {})}

Based on this information, provide a brief lead qualification summary and recommended next steps.
    `.trim();

    const response = await claude.sendMessage({
      messages: [{ role: 'user', content: context }],
      systemPrompt: propertySearchTemplate.system,
      maxTokens: 500,
      enableCache: false, // Don't cache unique lead data
    });

    // Add AI qualification as note in FUB
    await fub.createEvent({
      source: 'ai-assistant',
      type: 'Note',
      message: `AI Lead Qualification:\n\n${response.content}`,
      personId: person.id,
      data: {
        aiQualification: true,
        cost: response.cost.total,
      },
    });

    console.log(`[FUB] AI qualification added for ${person.name}`);
  } catch (error) {
    console.error('[FUB] Error qualifying lead with AI:', error);
  }
}

/**
 * Check for duplicate leads
 */
async function checkForDuplicates(personId: number) {
  const fub = new FollowUpBossClient({
    apiKey: process.env.FUB_API_KEY || '',
  });

  try {
    const person = await fub.getPerson(personId);

    // Search by email
    if (person.emails && person.emails.length > 0) {
      const duplicates = await fub.listPeople({
        email: person.emails[0].value,
        limit: 10,
      });

      if (duplicates.people.length > 1) {
        await fub.createEvent({
          source: 'automation',
          type: 'Note',
          message: `⚠️ Potential duplicate found - ${duplicates.people.length} contacts with this email`,
          personId,
        });
      }
    }

    // Search by phone
    if (person.phones && person.phones.length > 0) {
      const duplicates = await fub.listPeople({
        phone: person.phones[0].value,
        limit: 10,
      });

      if (duplicates.people.length > 1) {
        await fub.createEvent({
          source: 'automation',
          type: 'Note',
          message: `⚠️ Potential duplicate found - ${duplicates.people.length} contacts with this phone`,
          personId,
        });
      }
    }
  } catch (error) {
    console.error('[FUB] Error checking duplicates:', error);
  }
}

/**
 * Trigger property search
 */
async function triggerPropertySearch(personId: number, neighborhood?: string) {
  const fub = new FollowUpBossClient({
    apiKey: process.env.FUB_API_KEY || '',
  });

  try {
    const person = await fub.getPerson(personId);

    // Extract search criteria from custom fields
    const budget = person.customFields?.budget;
    const bedrooms = person.customFields?.bedrooms;
    const bathrooms = person.customFields?.bathrooms;

    let searchNote = `Property search criteria:\n`;
    if (neighborhood) searchNote += `- Area: ${neighborhood}\n`;
    if (budget) searchNote += `- Budget: ${budget}\n`;
    if (bedrooms) searchNote += `- Bedrooms: ${bedrooms}\n`;
    if (bathrooms) searchNote += `- Bathrooms: ${bathrooms}\n`;

    // TODO: Integrate with RealScout to create saved search
    // await createRealScoutSearch(person, { neighborhood, budget, bedrooms, bathrooms });

    await fub.createEvent({
      source: 'automation',
      type: 'Property Search',
      message: searchNote,
      personId,
      data: {
        neighborhood,
        budget,
        bedrooms,
        bathrooms,
      },
    });

    console.log(`[FUB] Property search triggered for ${person.name}`);
  } catch (error) {
    console.error('[FUB] Error triggering property search:', error);
  }
}

/**
 * Verify FUB webhook signature.
 *
 * Per Follow Up Boss docs (https://docs.followupboss.com/reference/webhooks-guide):
 * base64-encode the raw (non-prettified) JSON payload, compute an HMAC-SHA256
 * hash of that base64 string using your X-System-Key, and compare it to the
 * `FUB-Signature` header.
 */
function verifySignature(rawBody: string, signature: string | null, systemKey: string): boolean {
  if (!signature) return false;

  const encoded = Buffer.from(rawBody, 'utf8').toString('base64');
  const computed = createHmac('sha256', systemKey).update(encoded).digest('hex');

  const signatureBuffer = Buffer.from(signature);
  const computedBuffer = Buffer.from(computed);

  if (signatureBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, computedBuffer);
}
