'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import * as api from '@/lib/api';
import { useCommodityGroups } from '@/lib/hooks/useCommodityGroups';
import { Button, Input, Alert, Loader } from '@/components/base';

interface OrderLine {
  positionDescription: string;
  unitPrice: number;
  amount: number;
  unit: string;
  totalPrice: number;
  commodityGroupId?: number | null;
  commodityGroupName?: string | null;
  articleId?: string | null;
}

// Fields that, once manually edited, invalidate a previously applied catalog
// article match (treated as a deliberate override). Editing amount/quantity
// alone keeps the link, since the negotiated unit price still applies.
const FIELDS_THAT_CLEAR_ARTICLE_LINK = new Set(['positionDescription', 'unitPrice', 'unit']);

function MatchRow({
  match,
  onConfirm,
}: {
  match: api.SupplierMatch;
  onConfirm: (match: api.SupplierMatch) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm text-ink truncate">
          {match.supplier.name}
          {match.supplier.vat_id && (
            <span className="text-ink/45"> · {match.supplier.vat_id}</span>
          )}
        </p>
        <p className="text-xs text-ink/45">
          {match.match_type === 'vat' ? 'Matched by VAT ID' : `${Math.round(match.score * 100)}% name match`}
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onConfirm(match)}>
        Confirm
      </Button>
    </div>
  );
}

function ArticleMatchRow({
  match,
  onApply,
}: {
  match: api.ArticleMatch;
  onApply: (match: api.ArticleMatch) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm text-ink truncate">
          {match.article.article_number} — {match.article.description}
        </p>
        <p className="text-xs text-ink/45">
          €{parseFloat(match.article.unit_price).toFixed(2)} / {match.article.unit} ·{' '}
          {Math.round(match.score * 100)}% match
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onApply(match)}>
        Apply
      </Button>
    </div>
  );
}

export default function NewRequestPage() {
  const router = useRouter();
  const { data: commodityGroups } = useCommodityGroups();

  // Form state
  const [requestorName, setRequestorName] = useState('');
  const [title, setTitle] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [vatId, setVatId] = useState('');
  const [department, setDepartment] = useState('');
  const [commodityGroupId, setCommodityGroupId] = useState<number | null>(null);
  const [orderLines, setOrderLines] = useState<OrderLine[]>([]);
  const [totalCost, setTotalCost] = useState<number>(0);

  // UI state
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [warning, setWarning] = useState('');
  const [extracting, setExtracting] = useState(false);

  // --- Catalog article matching (negotiated prices) ---
  // A confirmed supplier scopes article matching to that supplier's catalog only.
  const [confirmedSupplier, setConfirmedSupplier] = useState<api.Supplier | null>(null);
  const [supplierMatches, setSupplierMatches] = useState<api.SupplierMatch[]>([]);
  const [supplierMatchLoading, setSupplierMatchLoading] = useState(false);
  const [showAllSupplierMatches, setShowAllSupplierMatches] = useState(false);
  const [vendorMatchDismissed, setVendorMatchDismissed] = useState(false);

  const [articleMatches, setArticleMatches] = useState<Record<number, api.ArticleMatch[]>>({});
  const [articleMatchLoading, setArticleMatchLoading] = useState(false);
  const [expandedLineMatches, setExpandedLineMatches] = useState<Record<number, boolean>>({});

  // Debounced vendor match lookup whenever the (unconfirmed) vendor name/VAT changes.
  useEffect(() => {
    if (confirmedSupplier) return; // already confirmed, no need to keep searching
    if (!vendorName.trim() && !vatId.trim()) {
      setSupplierMatches([]);
      return;
    }
    setVendorMatchDismissed(false);
    const handle = setTimeout(async () => {
      setSupplierMatchLoading(true);
      try {
        const { matches } = await api.suppliers.match({ name: vendorName, vatId });
        setSupplierMatches(matches);
      } catch {
        setSupplierMatches([]);
      }
      setSupplierMatchLoading(false);
    }, 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorName, vatId, confirmedSupplier]);

  // Debounced article match lookup for every line, scoped to the confirmed supplier.
  useEffect(() => {
    if (!confirmedSupplier || orderLines.length === 0) {
      setArticleMatches({});
      return;
    }
    const handle = setTimeout(async () => {
      const lines = orderLines
        .map((l, index) => ({ index, description: l.positionDescription }))
        .filter((l) => l.description.trim().length > 0);
      if (lines.length === 0) {
        setArticleMatches({});
        return;
      }
      setArticleMatchLoading(true);
      try {
        const { matches } = await api.articles.match({
          supplierId: confirmedSupplier.id,
          lines,
        });
        const byIndex: Record<number, api.ArticleMatch[]> = {};
        for (const [key, value] of Object.entries(matches)) {
          byIndex[Number(key)] = value;
        }
        setArticleMatches(byIndex);
      } catch {
        setArticleMatches({});
      }
      setArticleMatchLoading(false);
    }, 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedSupplier, orderLines.map((l) => l.positionDescription).join('|')]);

  const confirmSupplierMatch = (match: api.SupplierMatch) => {
    setConfirmedSupplier(match.supplier);
    setVendorName(match.supplier.name);
    if (match.supplier.vat_id) setVatId(match.supplier.vat_id);
    setSupplierMatches([]);
  };

  const applyArticleMatch = (index: number, match: api.ArticleMatch) => {
    const updated = [...orderLines];
    const unitPrice = parseFloat(match.article.unit_price);
    updated[index] = {
      ...updated[index],
      positionDescription: match.article.description,
      unitPrice,
      unit: match.article.unit,
      totalPrice: unitPrice * updated[index].amount,
      articleId: match.article.id,
    };
    setOrderLines(updated);
    setTotalCost(updated.reduce((sum, line) => sum + line.totalPrice, 0));
    setExpandedLineMatches((prev) => ({ ...prev, [index]: false }));
  };

  // PDF parsing mutation
  const parsePDFMutation = useMutation({
    mutationFn: async (file: File) => {
      const result = await api.pdf.parse(file);
      if (!result.text) {
        throw new Error('Failed to parse PDF');
      }
      return result.text;
    },
  });

  // Handle file upload and extraction
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    if (uploadedFile.type !== 'application/pdf') {
      setError('Please upload a PDF file');
      return;
    }

    setFile(uploadedFile);
    setError('');
    setSuccess('');
    setWarning('');
    setExtracting(true);

    try {
      // Step 1: Parse PDF
      const pdfText = await parsePDFMutation.mutateAsync(uploadedFile);

      // Step 2: Extract structured data AND classify commodity group in one AI call
      const extractionResult = await api.extraction.extract(pdfText);
      
      if (!extractionResult.success || !extractionResult.data) {
        throw new Error(extractionResult.error || 'Failed to extract data');
      }

      const extracted = extractionResult.data;

      // Step 3: Auto-fill form (including commodity group from extraction)
      setTitle(extracted.title || '');
      setVendorName(extracted.vendorName || '');
      setVatId(extracted.vatId || '');
      setDepartment(extracted.department || '');
      setOrderLines(extracted.orderLines || []);
      setTotalCost(extracted.totalCost || 0);
      
      // Set commodity group (now included in extraction)
      if (extracted.commodityGroupId) {
        setCommodityGroupId(extracted.commodityGroupId);
      }

      // Show warnings for missing fields
      if (extractionResult.missingFields && extractionResult.missingFields.length > 0) {
        setWarning(
          `⚠️ Could not extract: ${extractionResult.missingFields.join(', ')}. Please fill in these fields manually.`
        );
      }

      setSuccess('✓ PDF extracted successfully! Review and submit.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('Extraction error:', err);
      setError(err instanceof Error ? err.message : 'Failed to extract data from PDF');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setExtracting(false);
    }
  };

  // Add order line manually
  const addOrderLine = () => {
    setOrderLines([
      ...orderLines,
      {
        positionDescription: '',
        unitPrice: 0,
        amount: 1,
        unit: '',
        totalPrice: 0,
      },
    ]);
  };

  // Update order line
  const updateOrderLine = (index: number, field: keyof OrderLine, value: string | number | null) => {
    const updated = [...orderLines];
    updated[index] = { ...updated[index], [field]: value };

    // Auto-calculate total price
    if (field === 'unitPrice' || field === 'amount') {
      updated[index].totalPrice = updated[index].unitPrice * updated[index].amount;
    }

    // Manually editing a field that was used to apply a catalog match treats
    // the edit as a deliberate override — unlink the article so pricing/audit
    // no longer claims it came from the catalog. Amount-only edits keep the link.
    if (updated[index].articleId && FIELDS_THAT_CLEAR_ARTICLE_LINK.has(field)) {
      updated[index].articleId = null;
    }

    setOrderLines(updated);

    // Update total cost
    const newTotal = updated.reduce((sum, line) => sum + line.totalPrice, 0);
    setTotalCost(newTotal);
  };

  // Remove order line
  const removeOrderLine = (index: number) => {
    const updated = orderLines.filter((_, i) => i !== index);
    setOrderLines(updated);
    const newTotal = updated.reduce((sum, line) => sum + line.totalPrice, 0);
    setTotalCost(newTotal);
  };

  // Submit form
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setWarning('');

    // Validation with scroll to top on error
    if (!commodityGroupId) {
      setError('Please select a commodity group');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (orderLines.length === 0) {
      setError('Please add at least one order line');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    try {
      const created = await api.requests.create({
        requestorName,
        titleShortDescription: title,
        vendorName,
        vatId,
        commodityGroupId: commodityGroupId,
        totalCost,
        department,
        orderLines,
      });

      // Attach the original PDF (if one was uploaded) so it shows on the detail page.
      if (file) {
        try {
          await api.requests.uploadDocument(created.id, file);
        } catch {
          // Non-fatal — the request itself was created.
        }
      }

      setSuccess('Request created successfully! Redirecting...');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => {
        router.push('/dashboard/requests');
        router.refresh();
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create request');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">New Procurement Request</h1>
        <p className="text-gray-600 mt-2">
          Upload a vendor offer PDF or fill in the details manually
        </p>
      </div>

      {error && <Alert variant="error" className="mb-6">{error}</Alert>}
      {warning && <Alert variant="warning" className="mb-6">{warning}</Alert>}
      {success && <Alert variant="success" className="mb-6">{success}</Alert>}

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* PDF Upload Section */}
        <div className="lio-card p-6">
          <h2 className="text-xl font-semibold tracking-tight text-ink mb-4">Upload Vendor Offer (Optional)</h2>
          <p className="text-sm text-gray-600 mb-4">
            Upload a PDF to automatically extract vendor details and order items
          </p>

          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-accent-deep/50 transition-colors">
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              className="hidden"
              id="pdf-upload"
              disabled={extracting}
            />
            <label htmlFor="pdf-upload" className="cursor-pointer">
              {extracting ? (
                <div className="flex flex-col items-center">
                  <Loader size="lg" />
                  <p className="mt-4 text-sm text-gray-600">Extracting data from PDF...</p>
                </div>
              ) : file ? (
                <div>
                  <svg
                    className="mx-auto h-12 w-12 text-green-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <p className="mt-2 text-sm font-medium text-gray-900">{file.name}</p>
                  <p className="mt-1 text-xs text-gray-500">Click to upload a different file</p>
                </div>
              ) : (
                <div>
                  <svg
                    className="mx-auto h-12 w-12 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                  <p className="mt-2 text-sm text-gray-600">
                    Click to upload or drag and drop
                  </p>
                  <p className="mt-1 text-xs text-gray-500">PDF up to 10MB</p>
                </div>
              )}
            </label>
          </div>
        </div>

        {/* Request Details */}
        <div className="lio-card p-6 space-y-4">
          <h2 className="text-xl font-semibold tracking-tight text-ink mb-4">Request Details</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Requestor Name *"
              value={requestorName}
              onChange={(e) => setRequestorName(e.target.value)}
              required
              placeholder="John Doe"
            />

            <Input
              label="Department"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="IT Department"
            />
          </div>

          <Input
            label="Title / Short Description *"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="Adobe Creative Cloud Subscription"
          />
        </div>

        {/* Vendor Information */}
        <div className="lio-card p-6 space-y-4">
          <h2 className="text-xl font-semibold tracking-tight text-ink mb-4">Vendor Information</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Vendor Name *"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              required
              placeholder="Adobe Systems"
            />

            <Input
              label="VAT ID"
              value={vatId}
              onChange={(e) => setVatId(e.target.value)}
              placeholder="DE123456789"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Commodity Group *
            </label>
            <select
              value={commodityGroupId || ''}
              onChange={(e) => setCommodityGroupId(Number(e.target.value))}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-accent-deep/60 focus:border-accent-deep/40"
            >
              <option value="">
                {commodityGroups ? 'Select a commodity group' : 'Loading...'}
              </option>
              {commodityGroups?.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.id} - {group.category} - {group.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Vendor Match Banner - shows only if no supplier confirmed yet */}
        {!confirmedSupplier && !vendorMatchDismissed && (supplierMatches.length > 0 || supplierMatchLoading) && (
          <div className="lio-card p-4 bg-accent-soft/20 border border-accent/40">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div>
                <h3 className="text-sm font-semibold text-ink mb-1">
                  {supplierMatchLoading ? 'Searching catalog...' : 'Matching supplier found'}
                </h3>
                <p className="text-xs text-ink/60">
                  {supplierMatchLoading
                    ? 'Looking for vendors matching your input...'
                    : `Found ${supplierMatches.length} match${supplierMatches.length !== 1 ? 'es' : ''}. Confirm one to unlock negotiated pricing.`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setVendorMatchDismissed(true)}
                className="text-ink/45 hover:text-ink text-lg leading-none"
              >
                ✕
              </button>
            </div>
            {!supplierMatchLoading && supplierMatches.length > 0 && (
              <div className="space-y-1 mt-3">
                {(showAllSupplierMatches ? supplierMatches : supplierMatches.slice(0, 3)).map((match) => (
                  <MatchRow key={match.supplier.id} match={match} onConfirm={confirmSupplierMatch} />
                ))}
                {supplierMatches.length > 3 && !showAllSupplierMatches && (
                  <button
                    type="button"
                    onClick={() => setShowAllSupplierMatches(true)}
                    className="text-xs text-accent-deep hover:underline py-1"
                  >
                    Show {supplierMatches.length - 3} more
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Confirmed Supplier Badge */}
        {confirmedSupplier && (
          <div className="lio-card p-4 bg-green-50 border border-green-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink/60">Confirmed supplier</p>
                <p className="text-base font-semibold text-ink">{confirmedSupplier.name}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setConfirmedSupplier(null);
                  setArticleMatches({});
                  setExpandedLineMatches({});
                }}
              >
                Change
              </Button>
            </div>
          </div>
        )}

        {/* Order Lines */}
        <div className="lio-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold tracking-tight text-ink">Order Lines *</h2>
            <Button type="button" onClick={addOrderLine} variant="outline" size="sm">
              + Add Line
            </Button>
          </div>

          {orderLines.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No order lines yet. Add one to get started.
            </div>
          ) : (
            <div className="space-y-4">
              {orderLines.map((line, index) => (
                <div key={index} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="text-sm font-medium text-gray-700">Line {index + 1}</h3>
                    <button
                      type="button"
                      onClick={() => removeOrderLine(index)}
                      className="text-red-600 hover:text-red-700 text-sm"
                    >
                      Remove
                    </button>
                  </div>

                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
                     <div className="lg:col-span-2">
                       <Input
                         label="Description"
                         value={line.positionDescription}
                         onChange={(e) =>
                           updateOrderLine(index, 'positionDescription', e.target.value)
                         }
                         required
                         placeholder="Item description"
                       />
                     </div>

                     <Input
                       label="Unit Price (€)"
                       type="number"
                       step="0.01"
                       value={line.unitPrice}
                       onChange={(e) =>
                         updateOrderLine(index, 'unitPrice', parseFloat(e.target.value) || 0)
                       }
                       required
                     />

                     <Input
                       label="Amount"
                       type="number"
                       step="0.01"
                       value={line.amount}
                       onChange={(e) =>
                         updateOrderLine(index, 'amount', parseFloat(e.target.value) || 1)
                       }
                       required
                     />

                     <Input
                       label="Unit"
                       value={line.unit}
                       onChange={(e) => updateOrderLine(index, 'unit', e.target.value)}
                       required
                       placeholder="pcs, licenses, etc."
                     />

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Commodity Group
                        </label>
                        <select
                          value={line.commodityGroupId || ''}
                          onChange={(e) =>
                            updateOrderLine(index, 'commodityGroupId', 
                              e.target.value ? Number(e.target.value) : null)
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-accent-deep/60 focus:border-accent-deep/40"
                        >
                          <option value="">
                            {commodityGroups ? 'Select a commodity group' : 'Loading...'}
                          </option>
                          {commodityGroups?.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.id} - {group.category} - {group.name}
                            </option>
                          ))}
                        </select>
                       </div>
                    </div>

                     <div className="mt-4 flex items-center justify-between">
                       <div className="flex items-center gap-2">
                         {line.articleId && (
                           <span className="inline-flex px-2.5 py-1 rounded-full bg-green-100 text-green-800 text-xs font-semibold">
                             ✓ Catalog article
                           </span>
                         )}
                       </div>
                       <div className="text-right">
                         <span className="text-sm text-gray-600">Total: </span>
                         <span className="text-lg font-semibold tracking-tight text-ink">
                           €{line.totalPrice.toFixed(2)}
                         </span>
                       </div>
                     </div>

                     {/* Article Match Suggestions - only if supplier is confirmed */}
                     {confirmedSupplier && (articleMatches[index]?.length || 0) > 0 && (
                       <div className="mt-4 pt-4 border-t border-gray-200">
                         <button
                           type="button"
                           onClick={() =>
                             setExpandedLineMatches((prev) => ({
                               ...prev,
                               [index]: !prev[index],
                             }))
                           }
                           className="text-xs font-medium text-accent-deep hover:underline flex items-center gap-1"
                         >
                           {expandedLineMatches[index] ? '▼' : '▶'}{' '}
                           {line.articleId
                             ? 'Applied article (show alternatives)'
                             : `${articleMatches[index].length} matching catalog item${articleMatches[index].length !== 1 ? 's' : ''}`}
                         </button>
                         {expandedLineMatches[index] && (
                           <div className="mt-2 space-y-1">
                             {articleMatches[index].map((match) => (
                               <ArticleMatchRow
                                 key={match.article.id}
                                 match={match}
                                 onApply={() => applyArticleMatch(index, match)}
                               />
                             ))}
                           </div>
                         )}
                       </div>
                     )}
                  </div>
               ))}
             </div>
           )}
        </div>

        {/* Total Cost */}
        <div className="bg-accent-soft/20 border-2 border-accent/40 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <span className="text-lg font-medium text-gray-900">Total Cost</span>
            <span className="text-3xl font-bold text-accent-deep">
              €{totalCost.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Submit */}
        <div className="flex items-center justify-end space-x-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.back()}
          >
            Cancel
          </Button>
          <Button type="submit" size="lg">
            Create Request
          </Button>
        </div>
      </form>
    </div>
  );
}

